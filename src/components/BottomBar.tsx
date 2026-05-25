import { useEffect, useState, useRef, useCallback } from 'react';
import { Wand2, X, Loader2, Square, Circle, Minus, Layers, ArrowRight } from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCanvasStore } from '../store/useCanvasStore';
import {
  ArrowObject,
  CanvasObject,
  EllipseObject,
  FrameObject,
  LineObject,
  RectObject,
  StrokeObject,
  TextObject,
} from '../types/canvas';
import { generateImage, editImage } from '../api/openai';
import { hasOpenAiApiKey, requestOpenAiApiKey } from '../services/openaiKey';
import {
  buildOutpaintComposite, buildOutpaintMask,
  buildFrameBaseImage, buildTransparentMask,
} from '../utils/frameCapture';

const FRAME_TOOLS = ['frame', 'imageFrame', 'siteFrame'] as const;
const CANVAS_LEFT_OFFSET = 64; // toolbar width
const MIXED = 'mixed' as const;
type MixedValue<T> = T | typeof MIXED;

function isFrameTool(tool: string): boolean {
  return FRAME_TOOLS.includes(tool as (typeof FRAME_TOOLS)[number]);
}

function computeFitTransform(frames: FrameObject[], canvasW: number, canvasH: number) {
  const PAD = 60;
  const minX = Math.min(...frames.map(f => f.x));
  const minY = Math.min(...frames.map(f => f.y));
  const maxX = Math.max(...frames.map(f => f.x + f.width));
  const maxY = Math.max(...frames.map(f => f.y + f.height));
  const scale = Math.max(0.05, Math.min(
    (canvasW - PAD * 2) / (maxX - minX),
    (canvasH - PAD * 2) / (maxY - minY),
    1,
  ));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { stageX: canvasW / 2 - cx * scale, stageY: canvasH / 2 - cy * scale, stageScale: scale };
}

// ─── Color utilities ──────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length === 3) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16)];
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d % 6) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    if (h < 0) h += 1;
  }
  return [h * 360, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h /= 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r=v; g=t; b=p; break; case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break; case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break; case 5: r=v; g=p; b=q; break;
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function parseColorToHsva(color: string): [number, number, number, number] {
  if (color === 'transparent') return [0, 0, 1, 0];
  const rgba = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgba) return [...rgbToHsv(+rgba[1], +rgba[2], +rgba[3]), rgba[4] !== undefined ? +rgba[4] : 1] as [number,number,number,number];
  try {
    const h = color.startsWith('#') ? color : '#' + color;
    const clean = h.replace('#', '');
    const [r, g, b] = hexToRgb(h);
    const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
    return [...rgbToHsv(r, g, b), a] as [number,number,number,number];
  } catch { return [0, 0, 1, 1]; }
}

function buildColor(h: number, s: number, v: number, a: number): string {
  const [r, g, b] = hsvToRgb(h, s, v);
  if (a >= 0.999) return rgbToHex(r, g, b);
  return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
}

const CHECKER = 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 0 0 / 10px 10px';

// ─── Color Picker Popup ───────────────────────────────────────────────────────

function ColorPickerPopup({
  color,
  onChange,
}: {
  color: string;
  onChange: (c: string) => void;
}) {
  const recentColors = useCanvasStore((s) => s.recentColors);
  const addRecentColor = useCanvasStore((s) => s.addRecentColor);

  const init = parseColorToHsva(color === 'transparent' ? '#ffffff' : color);
  const [hue, setHue] = useState(init[0]);
  const [sat, setSat] = useState(init[1]);
  const [val, setVal] = useState(init[2]);
  const [alpha, setAlpha] = useState(init[3]);
  const stateRef = useRef({ hue, sat, val, alpha });
  stateRef.current = { hue, sat, val, alpha };
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const addRecentRef = useRef(addRecentColor);
  addRecentRef.current = addRecentColor;

  const [hexInput, setHexInput] = useState(() => rgbToHex(...hsvToRgb(init[0], init[1], init[2])));

  const emit = useCallback((h: number, s: number, v: number, a: number) => {
    setHue(h); setSat(s); setVal(v); setAlpha(a);
    setHexInput(rgbToHex(...hsvToRgb(h, s, v)));
    onChangeRef.current(buildColor(h, s, v, a));
  }, []);

  useEffect(() => () => {
    const { hue: h, sat: s, val: v, alpha: a } = stateRef.current;
    const c = buildColor(h, s, v, a);
    if (c !== 'transparent') addRecentRef.current(c);
  }, []);

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);

  const makeDragger = (onMove: (ev: MouseEvent) => void) => (e: React.MouseEvent) => {
    onMove(e.nativeEvent);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
    e.preventDefault();
  };

  const startHueDrag = makeDragger((ev) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const h = clamp01((ev.clientX - rect.left) / rect.width) * 360;
    const { sat: s, val: v, alpha: a } = stateRef.current;
    emit(h, s, v, a);
  });

  const startSVDrag = makeDragger((ev) => {
    if (!svRef.current) return;
    const rect = svRef.current.getBoundingClientRect();
    const s = clamp01((ev.clientX - rect.left) / rect.width);
    const v = clamp01(1 - (ev.clientY - rect.top) / rect.height);
    const { hue: h, alpha: a } = stateRef.current;
    emit(h, s, v, a);
  });

  const startAlphaDrag = makeDragger((ev) => {
    if (!alphaRef.current) return;
    const rect = alphaRef.current.getBoundingClientRect();
    const a = clamp01((ev.clientX - rect.left) / rect.width);
    const { hue: h, sat: s, val: v } = stateRef.current;
    emit(h, s, v, a);
  });

  const commitHex = () => {
    try {
      const hex = hexInput.startsWith('#') ? hexInput : '#' + hexInput;
      const [r, g, b] = hexToRgb(hex);
      const [h, s, v] = rgbToHsv(r, g, b);
      emit(h, s, v, alpha);
    } catch {}
  };

  const hueHex = rgbToHex(...hsvToRgb(hue, 1, 1));
  const currentColor = buildColor(hue, sat, val, alpha);

  return (
    <div
      style={{
        width: 240,
        background: 'var(--theme-menu-bg)',
        border: '1px solid var(--theme-toolbar-border)',
        borderRadius: 12,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        userSelect: 'none',
      }}
    >
      {/* Hue slider */}
      <div ref={hueRef} onMouseDown={startHueDrag} style={{ height: 14, borderRadius: 7, background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', position: 'relative', cursor: 'ew-resize', flexShrink: 0 }}>
        <div style={{
          position: 'absolute', left: `${(hue / 360) * 100}%`, top: '50%',
          transform: 'translate(-50%,-50%)', width: 16, height: 16, borderRadius: '50%',
          border: '2px solid #fff', background: hueHex, boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* SV rectangle */}
      <div ref={svRef} onMouseDown={startSVDrag} style={{ height: 150, position: 'relative', cursor: 'crosshair', flexShrink: 0 }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 6,
          background: `linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, ${hueHex})`,
        }} />
        <div style={{
          position: 'absolute', left: `${sat * 100}%`, top: `${(1 - val) * 100}%`,
          transform: 'translate(-50%,-50%)', width: 12, height: 12, borderRadius: '50%',
          border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
          pointerEvents: 'none', zIndex: 1,
        }} />
      </div>

      {/* Recent colors */}
      {recentColors.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {recentColors.map((rc, i) => (
            <button
              key={i}
              title={rc}
              onClick={() => {
                const [h, s, v, a] = parseColorToHsva(rc);
                emit(h, s, v, a);
              }}
              style={{
                width: 20, height: 20, borderRadius: 4, border: '1.5px solid var(--theme-swatch-border)',
                background: rc, cursor: 'pointer', flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}

      {/* Hex input + preview + transparent */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 26, height: 26, borderRadius: 6, background: currentColor, border: '1.5px solid var(--theme-swatch-border)', flexShrink: 0 }} />
        <input
          type="text"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitHex(); } e.stopPropagation(); }}
          style={{ flex: 1, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-input-border)', borderRadius: 6, color: 'var(--theme-text-dim)', fontSize: 12, padding: '4px 8px', outline: 'none', fontFamily: 'monospace' }}
        />
        <button
          onClick={() => onChange('transparent')}
          title="Transparent"
          style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid var(--theme-swatch-border)', background: CHECKER, cursor: 'pointer', flexShrink: 0 }}
        />
      </div>

      {/* Opacity slider */}
      <div ref={alphaRef} onMouseDown={startAlphaDrag} style={{ height: 14, borderRadius: 7, position: 'relative', cursor: 'ew-resize', flexShrink: 0 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 7, background: CHECKER }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: 7, background: `linear-gradient(to right, transparent, ${hueHex})` }} />
        <div style={{
          position: 'absolute', left: `${alpha * 100}%`, top: '50%',
          transform: 'translate(-50%,-50%)', width: 16, height: 16, borderRadius: '50%',
          border: '2px solid #fff', background: currentColor, boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
          pointerEvents: 'none', zIndex: 1,
        }} />
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function Swatch({ color, onClick }: { color: MixedValue<string>; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: color === MIXED ? 48 : 28,
        height: 28,
        borderRadius: 6,
        border: '2px solid var(--theme-swatch-border)',
        background: color === MIXED
          ? 'var(--theme-surface)'
          : color === 'transparent'
          ? 'repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 0 0 / 8px 8px'
          : color,
        color: 'var(--theme-text-muted)',
        fontSize: 10,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {color === MIXED ? 'mixed' : ''}
    </button>
  );
}

function ColorRow({
  label,
  color,
  onChange,
}: {
  label: string;
  color: MixedValue<string>;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const effectiveColor = color === MIXED ? '#ffffff' : color === 'transparent' ? 'transparent' : color;

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
      <Swatch color={color} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div style={{ position: 'absolute', bottom: 44, left: 0, zIndex: 100 }}>
          <ColorPickerPopup
            color={effectiveColor}
            onChange={(c) => { onChange(c); }}
          />
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: MixedValue<number>;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startValue = useRef(0);
  const [active, setActive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startValue.current = value === MIXED ? min : value;
    setActive(true);
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - startX.current;
      const sensitivity = (max - min) / 200;
      const raw = startValue.current + dx * sensitivity;
      const stepped = Math.round(raw / step) * step;
      const clamped = Math.max(min, Math.min(max, stepped));
      onChange(clamped);
    };

    const onUp = () => {
      dragging.current = false;
      setActive(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(value === MIXED ? MIXED : format ? format(value) : String(value));
    setEditing(true);
  };

  const commitEdit = () => {
    const num = parseFloat(editText.replace(/[^0-9.\-]/g, ''));
    if (!isNaN(num)) {
      const stepped = Math.round(num / step) * step;
      onChange(Math.max(min, Math.min(max, stepped)));
    }
    setEditing(false);
  };

  return (
    <div
      onMouseDown={editing ? undefined : onMouseDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 8px',
        borderRadius: 6,
        background: active ? 'var(--theme-surface-active)' : 'var(--theme-surface)',
        border: `1px solid ${active || editing ? '#6366f1' : 'var(--theme-toolbar-border)'}`,
        cursor: editing ? 'default' : 'ew-resize',
        userSelect: 'none',
        flexShrink: 0,
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
      {editing ? (
        <input
          type="text"
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            e.stopPropagation();
          }}
          style={{
            width: 36,
            background: 'transparent',
            border: 'none',
            color: 'var(--theme-text-dim)',
            fontSize: 11,
            outline: 'none',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'text',
          }}
        />
      ) : (
        <span
          onClick={startEdit}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ fontSize: 11, color: 'var(--theme-text-dim)', minWidth: 20, textAlign: 'right', fontVariantNumeric: 'tabular-nums', cursor: 'text' }}
        >
          {value === MIXED ? MIXED : format ? format(value) : value}
        </span>
      )}
    </div>
  );
}

// ─── Panel sections ────────────────────────────────────────────────────────────

function PenPanel() {
  const { brushColor, setBrushColor, brushSize, setBrushSize, brushOpacity, setBrushOpacity } =
    useCanvasStore();
  return (
    <>
      <ColorRow label="Color" color={brushColor} onChange={setBrushColor} />
      <Divider />
      <Slider label="Width" value={brushSize} min={1} max={80} step={1} onChange={setBrushSize} />
      <Slider
        label="Opacity"
        value={Math.round(brushOpacity * 100)}
        min={10}
        max={100}
        step={1}
        onChange={(v) => setBrushOpacity(v / 100)}
        format={(v) => `${v}%`}
      />
    </>
  );
}

function ArrowPanel() {
  const { shapeStrokeColor, setShapeStrokeColor, shapeStrokeWidth, setShapeStrokeWidth } = useCanvasStore();
  return (
    <>
      <ColorRow label="Color" color={shapeStrokeColor} onChange={setShapeStrokeColor} />
      <Divider />
      <Slider label="Width" value={shapeStrokeWidth} min={0.5} max={40} step={0.5} onChange={setShapeStrokeWidth} />
    </>
  );
}

function ShapePanel() {
  const {
    fillColor, setFillColor,
    shapeStrokeColor, setShapeStrokeColor,
    shapeStrokeWidth, setShapeStrokeWidth,
  } = useCanvasStore();

  return (
    <>
      <ColorRow label="Fill" color={fillColor} onChange={setFillColor} />
      <ColorRow label="Stroke" color={shapeStrokeColor} onChange={setShapeStrokeColor} />
      <Divider />
      <Slider label="Width" value={shapeStrokeWidth} min={0} max={20} step={0.5} onChange={setShapeStrokeWidth} />
    </>
  );
}

function TextPanel() {
  const { fontColor, setFontColor, fontSize, setFontSize } = useCanvasStore();
  return (
    <>
      <ColorRow label="Color" color={fontColor} onChange={setFontColor} />
      <Divider />
      <Slider label="Size" value={fontSize} min={8} max={120} step={1} onChange={setFontSize} />
    </>
  );
}

const RATIO_PRESETS = [
  { label: '1:1',  width: 512, height: 512 },
  { label: '4:3',  width: 512, height: 384 },
  { label: '16:9', width: 512, height: 288 },
  { label: '3:4',  width: 384, height: 512 },
  { label: '9:16', width: 288, height: 512 },
] as const;

function normalizeFrameUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function FrameUrlControls({ frame }: { frame: FrameObject }) {
  const { updateObject } = useCanvasStore();
  const [value, setValue] = useState(frame.url ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(frame.url ?? '');
    setError('');
  }, [frame.id, frame.url]);

  const apply = () => {
    const normalized = normalizeFrameUrl(value);
    if (!normalized) {
      updateObject(frame.id, { url: null });
      setError('');
      return;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('Use http or https');
        return;
      }
      updateObject(frame.id, { url: parsed.toString(), imageData: null, priorBounds: null });
      setValue(parsed.toString());
      setError('');
    } catch (_) {
      setError('Invalid URL');
    }
  };

  return (
    <>
      <input
        type="text"
        placeholder="https://example.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        onBlur={apply}
        onFocus={(e) => e.target.select()}
        style={{ ...promptInputStyle, width: 260 }}
      />
      {error && <span style={{ fontSize: 11, color: '#ef4444' }}>{error}</span>}
    </>
  );
}

function FrameSizeControls({ frame }: { frame: FrameObject }) {
  const { updateObject } = useCanvasStore();
  const update = (updates: Partial<CanvasObject>) => updateObject(frame.id, updates);

  return (
    <>
      <Slider label="W" value={Math.round(frame.width)} min={64} max={2048} step={1} onChange={(width) => update({ width })} />
      <Slider label="H" value={Math.round(frame.height)} min={64} max={2048} step={1} onChange={(height) => update({ height })} />
    </>
  );
}

function PlainFrameControls({ frame }: { frame: FrameObject }) {
  const { updateObject } = useCanvasStore();
  return (
    <>
      <ColorRow
        label="Bg"
        color={frame.background ?? '#181818'}
        onChange={(background) => updateObject(frame.id, { background })}
      />
      <Divider />
      <FrameSizeControls frame={frame} />
    </>
  );
}

function sharedValue<TObject extends CanvasObject, TValue>(
  objects: TObject[],
  read: (obj: TObject) => TValue,
): MixedValue<TValue> {
  const [first, ...rest] = objects.map(read);
  return rest.every((value) => Object.is(value, first)) ? first : MIXED;
}

function canShowMultiSelectedPanel(objects: CanvasObject[]): boolean {
  if (objects.length === 0) return false;
  if (objects.length === 1) return true;
  if (objects.every((obj) => obj.type === 'line' || obj.type === 'arrow')) return true;
  if (objects.every((obj) => obj.type === 'rect' || obj.type === 'ellipse')) return true;
  if (objects.every((obj) => obj.type === 'frame')) return true;
  return objects.every((obj) => obj.type === objects[0].type);
}

function SelectedObjectsPanel({ objects }: { objects: CanvasObject[] }) {
  const { updateObjects } = useCanvasStore();
  const updateAll = (updates: (obj: CanvasObject) => Partial<CanvasObject>) => {
    updateObjects(Object.fromEntries(objects.map((obj) => [obj.id, updates(obj)])));
  };

  if (objects.length === 1) return <SelectedObjectPanel obj={objects[0]} />;

  if (objects.every((obj) => obj.type === 'stroke')) {
    const strokes = objects as StrokeObject[];
    return (
      <>
        <ColorRow label="Color" color={sharedValue(strokes, (obj) => obj.color)} onChange={(color) => updateAll(() => ({ color }))} />
        <Divider />
        <Slider label="Width" value={sharedValue(strokes, (obj) => obj.size)} min={1} max={80} step={1} onChange={(size) => updateAll(() => ({ size }))} />
        <Slider
          label="Opacity"
          value={sharedValue(strokes, (obj) => Math.round(obj.opacity * 100))}
          min={10}
          max={100}
          step={1}
          onChange={(v) => updateAll(() => ({ opacity: v / 100 }))}
          format={(v) => `${v}%`}
        />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'rect')) {
    const rects = objects as RectObject[];
    return (
      <>
        <ColorRow label="Fill" color={sharedValue(rects, (obj) => obj.fill)} onChange={(fill) => updateAll(() => ({ fill }))} />
        <ColorRow label="Stroke" color={sharedValue(rects, (obj) => obj.stroke)} onChange={(stroke) => updateAll(() => ({ stroke }))} />
        <Divider />
        <Slider label="Width" value={sharedValue(rects, (obj) => obj.strokeWidth)} min={0} max={20} step={0.5} onChange={(strokeWidth) => updateAll(() => ({ strokeWidth }))} />
        <Slider label="W" value={sharedValue(rects, (obj) => Math.round(obj.width))} min={4} max={2000} step={1} onChange={(width) => updateAll(() => ({ width }))} />
        <Slider label="H" value={sharedValue(rects, (obj) => Math.round(obj.height))} min={4} max={2000} step={1} onChange={(height) => updateAll(() => ({ height }))} />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'ellipse')) {
    const ellipses = objects as EllipseObject[];
    return (
      <>
        <ColorRow label="Fill" color={sharedValue(ellipses, (obj) => obj.fill)} onChange={(fill) => updateAll(() => ({ fill }))} />
        <ColorRow label="Stroke" color={sharedValue(ellipses, (obj) => obj.stroke)} onChange={(stroke) => updateAll(() => ({ stroke }))} />
        <Divider />
        <Slider label="Width" value={sharedValue(ellipses, (obj) => obj.strokeWidth)} min={0} max={20} step={0.5} onChange={(strokeWidth) => updateAll(() => ({ strokeWidth }))} />
        <Slider label="W" value={sharedValue(ellipses, (obj) => Math.round(obj.radiusX * 2))} min={4} max={2000} step={1} onChange={(width) => updateAll(() => ({ radiusX: width / 2 }))} />
        <Slider label="H" value={sharedValue(ellipses, (obj) => Math.round(obj.radiusY * 2))} min={4} max={2000} step={1} onChange={(height) => updateAll(() => ({ radiusY: height / 2 }))} />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'rect' || obj.type === 'ellipse')) {
    const shapes = objects as (RectObject | EllipseObject)[];
    const shapeWidth = (obj: RectObject | EllipseObject) =>
      obj.type === 'rect' ? obj.width : obj.radiusX * 2;
    const shapeHeight = (obj: RectObject | EllipseObject) =>
      obj.type === 'rect' ? obj.height : obj.radiusY * 2;

    return (
      <>
        <ColorRow label="Fill" color={sharedValue(shapes, (obj) => obj.fill)} onChange={(fill) => updateAll(() => ({ fill }))} />
        <ColorRow label="Stroke" color={sharedValue(shapes, (obj) => obj.stroke)} onChange={(stroke) => updateAll(() => ({ stroke }))} />
        <Divider />
        <Slider label="Width" value={sharedValue(shapes, (obj) => obj.strokeWidth)} min={0} max={20} step={0.5} onChange={(strokeWidth) => updateAll(() => ({ strokeWidth }))} />
        <Slider
          label="W"
          value={sharedValue(shapes, (obj) => Math.round(shapeWidth(obj)))}
          min={4}
          max={2000}
          step={1}
          onChange={(width) => updateAll((obj) => obj.type === 'rect' ? { width } : { radiusX: width / 2 })}
        />
        <Slider
          label="H"
          value={sharedValue(shapes, (obj) => Math.round(shapeHeight(obj)))}
          min={4}
          max={2000}
          step={1}
          onChange={(height) => updateAll((obj) => obj.type === 'rect' ? { height } : { radiusY: height / 2 })}
        />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'line' || obj.type === 'arrow')) {
    const strokedObjects = objects as (LineObject | ArrowObject)[];
    return (
      <>
        <ColorRow label="Color" color={sharedValue(strokedObjects, (obj) => obj.stroke)} onChange={(stroke) => updateAll(() => ({ stroke }))} />
        <Divider />
        <Slider label="Width" value={sharedValue(strokedObjects, (obj) => obj.strokeWidth)} min={0.5} max={40} step={0.5} onChange={(strokeWidth) => updateAll(() => ({ strokeWidth }))} />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'text')) {
    const texts = objects as TextObject[];
    return (
      <>
        <ColorRow label="Color" color={sharedValue(texts, (obj) => obj.color)} onChange={(color) => updateAll(() => ({ color }))} />
        <Divider />
        <Slider label="Size" value={sharedValue(texts, (obj) => obj.fontSize)} min={8} max={120} step={1} onChange={(fontSize) => updateAll(() => ({ fontSize }))} />
      </>
    );
  }

  if (objects.every((obj) => obj.type === 'frame')) {
    const frames = objects as FrameObject[];
    const allPlain = frames.every((obj) => (obj.kind ?? 'image') === 'plain');
    return (
      <>
        {allPlain && (
          <>
            <ColorRow label="Bg" color={sharedValue(frames, (obj) => obj.background ?? '#181818')} onChange={(background) => updateAll(() => ({ background }))} />
            <Divider />
          </>
        )}
        <Slider label="W" value={sharedValue(frames, (obj) => Math.round(obj.width))} min={64} max={2048} step={1} onChange={(width) => updateAll(() => ({ width }))} />
        <Slider label="H" value={sharedValue(frames, (obj) => Math.round(obj.height))} min={64} max={2048} step={1} onChange={(height) => updateAll(() => ({ height }))} />
      </>
    );
  }

  return null;
}

function SelectedObjectPanel({ obj }: { obj: CanvasObject }) {
  const { updateObject } = useCanvasStore();
  const update = (updates: Partial<CanvasObject>) => updateObject(obj.id, updates);

  if (obj.type === 'stroke') {
    return (
      <>
        <ColorRow label="Color" color={obj.color} onChange={(color) => update({ color })} />
        <Divider />
        <Slider label="Width" value={obj.size} min={1} max={80} step={1} onChange={(size) => update({ size })} />
        <Slider
          label="Opacity"
          value={Math.round(obj.opacity * 100)}
          min={10}
          max={100}
          step={1}
          onChange={(v) => update({ opacity: v / 100 })}
          format={(v) => `${v}%`}
        />
      </>
    );
  }

  if (obj.type === 'rect') {
    return (
      <>
        <ColorRow label="Fill" color={obj.fill} onChange={(fill) => update({ fill })} />
        <ColorRow label="Stroke" color={obj.stroke} onChange={(stroke) => update({ stroke })} />
        <Divider />
        <Slider label="Width" value={obj.strokeWidth} min={0} max={20} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
        <Slider label="W" value={Math.round(obj.width)} min={4} max={2000} step={1} onChange={(width) => update({ width })} />
        <Slider label="H" value={Math.round(obj.height)} min={4} max={2000} step={1} onChange={(height) => update({ height })} />
      </>
    );
  }

  if (obj.type === 'ellipse') {
    return (
      <>
        <ColorRow label="Fill" color={obj.fill} onChange={(fill) => update({ fill })} />
        <ColorRow label="Stroke" color={obj.stroke} onChange={(stroke) => update({ stroke })} />
        <Divider />
        <Slider label="Width" value={obj.strokeWidth} min={0} max={20} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
        <Slider label="W" value={Math.round(obj.radiusX * 2)} min={4} max={2000} step={1} onChange={(width) => update({ radiusX: width / 2 })} />
        <Slider label="H" value={Math.round(obj.radiusY * 2)} min={4} max={2000} step={1} onChange={(height) => update({ radiusY: height / 2 })} />
      </>
    );
  }

  if (obj.type === 'line') {
    return (
      <>
        <ColorRow label="Color" color={obj.stroke} onChange={(stroke) => update({ stroke })} />
        <Divider />
        <Slider label="Width" value={obj.strokeWidth} min={0.5} max={40} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
      </>
    );
  }

  if (obj.type === 'arrow') {
    return (
      <>
        <ColorRow label="Color" color={obj.stroke} onChange={(stroke) => update({ stroke })} />
        <Divider />
        <Slider label="Width" value={obj.strokeWidth} min={0.5} max={40} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
      </>
    );
  }

  if (obj.type === 'text') {
    return (
      <>
        <ColorRow label="Color" color={obj.color} onChange={(color) => update({ color })} />
        <Divider />
        <Slider label="Size" value={obj.fontSize} min={8} max={120} step={1} onChange={(fontSize) => update({ fontSize })} />
      </>
    );
  }

  if (obj.type === 'frame') {
    return <FrameToolPanel frame={obj} />;
  }

  return null;
}

function FrameToolPanel({ frame, tool: activeTool }: { frame?: FrameObject; tool?: string }) {
  const {
    objects, addObject, updateObject, setIsGenerating, isGenerating, setOutpaintFrameId,
    incrementFrameCount, setSelectedIds,
    stageX, stageY, stageScale, setStageTransform,
    contextFrameIds, setContextFrameIds, toggleContextFrame,
    contextPickerActive, setContextPickerActive,
    captureFrameSnapshot,
  } = useCanvasStore();
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [selectedRatio, setSelectedRatio] = useState<typeof RATIO_PRESETS[number]['label']>('1:1');
  const { width: createWidth, height: createHeight } = RATIO_PRESETS.find(p => p.label === selectedRatio)!;
  const prevFrameIdRef = useRef<string | undefined>(undefined);

  // For imageFrame tool, only treat image frames as the "active frame"
  const effectiveFrame = activeTool === 'imageFrame'
    ? (frame?.kind === 'image' ? frame : undefined)
    : frame;

  // Clear context + close picker when the effective frame changes
  useEffect(() => {
    if (effectiveFrame?.id !== prevFrameIdRef.current) {
      setContextFrameIds([]);
      setContextPickerActive(false);
      prevFrameIdRef.current = effectiveFrame?.id;
    }
  }, [effectiveFrame?.id, setContextFrameIds, setContextPickerActive]);

  // Close picker on Escape
  useEffect(() => {
    if (!contextPickerActive) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextPickerActive(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextPickerActive, setContextPickerActive]);

  const captureContextFrameImages = async (): Promise<string[]> => {
    const failed: string[] = [];
    const captures = new Map<string, string>();

    const frames = contextFrameIds
      .map(id => objects.find((o): o is FrameObject => o.type === 'frame' && o.id === id))
      .filter((f): f is FrameObject => !!f);

    const siteFrames = frames.filter(f => f.kind === 'site');
    const otherFrames = frames.filter(f => f.kind !== 'site');

    // Site frames: fit all into view, one getDisplayMedia dialog, crop each mathematically
    if (siteFrames.length > 0) {
      const canvasW = window.innerWidth - CANVAS_LEFT_OFFSET;
      const canvasH = window.innerHeight;
      const fit = computeFitTransform(siteFrames, canvasW, canvasH);
      const saved = { stageX, stageY, stageScale };
      setStageTransform(fit.stageX, fit.stageY, fit.stageScale);
      await new Promise<void>(r => setTimeout(r, 150)); // wait for React + browser paint

      try {
        const stream = await (navigator.mediaDevices as any).getDisplayMedia({
          video: true,
          preferCurrentTab: true,
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await new Promise<void>(resolve => { video.onloadedmetadata = () => resolve(); });
        await video.play();
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

        const screen = document.createElement('canvas');
        screen.width = video.videoWidth;
        screen.height = video.videoHeight;
        screen.getContext('2d')!.drawImage(video, 0, 0);
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());

        const sx = screen.width / window.innerWidth;
        const sy = screen.height / window.innerHeight;

        for (const frame of siteFrames) {
          const vpL = (CANVAS_LEFT_OFFSET + fit.stageX + frame.x * fit.stageScale) * sx;
          const vpT = (fit.stageY + frame.y * fit.stageScale) * sy;
          const vpW = Math.round(frame.width * fit.stageScale * sx);
          const vpH = Math.round(frame.height * fit.stageScale * sy);
          if (vpW <= 0 || vpH <= 0) { failed.push(frame.label); continue; }
          const crop = document.createElement('canvas');
          crop.width = vpW;
          crop.height = vpH;
          crop.getContext('2d')!.drawImage(screen, Math.round(vpL), Math.round(vpT), vpW, vpH, 0, 0, vpW, vpH);
          captures.set(frame.id, crop.toDataURL('image/png'));
        }
      } catch {
        siteFrames.forEach(f => failed.push(f.label));
      } finally {
        setStageTransform(saved.stageX, saved.stageY, saved.stageScale);
      }
    }

    // Non-site frames: Konva stage capture
    for (const frame of otherFrames) {
      if (!captureFrameSnapshot) { failed.push(frame.label); continue; }
      try {
        captures.set(frame.id, await captureFrameSnapshot(frame));
      } catch {
        failed.push(frame.label);
      }
    }

    if (failed.length > 0) {
      setError(`Could not capture context frame${failed.length > 1 ? 's' : ''}: ${failed.join(', ')}`);
    }

    return contextFrameIds
      .map(id => captures.get(id))
      .filter((v): v is string => !!v);
  };

  const generateIntoFrame = async (targetFrame: FrameObject) => {
    const childAnnotations = objects.filter((obj) => obj.type !== 'frame' && obj.parentFrameId === targetFrame.id);
    const hasAnnotations = childAnnotations.length > 0;
    const guidedPrompt = hasAnnotations
      ? `${prompt.trim()}\n\nThis frame includes user annotations in a separate reference image. Use them only as guidance for layout, intent, and labels. Do not reproduce annotation marks, handwriting, wireframe lines, arrows, or instruction text in the final image.`
      : prompt.trim();

    const contextCaptures = await captureContextFrameImages();
    const annotationReference = hasAnnotations && captureFrameSnapshot ? await captureFrameSnapshot(targetFrame) : null;

    if (targetFrame.priorBounds && targetFrame.imageData) {
      const newBounds = { x: targetFrame.x, y: targetFrame.y, width: targetFrame.width, height: targetFrame.height };
      const [composite, mask] = await Promise.all([
        buildOutpaintComposite(targetFrame.imageData, targetFrame.priorBounds, newBounds),
        Promise.resolve(buildOutpaintMask(targetFrame.priorBounds, newBounds)),
      ]);
      const refs = [...(annotationReference ? [annotationReference] : []), ...contextCaptures];
      const result = await editImage(composite, mask, guidedPrompt, targetFrame.width, targetFrame.height, refs);
      updateObject(targetFrame.id, { url: null, imageData: result, generating: false, priorBounds: null });
      setOutpaintFrameId(null);
    } else if (hasAnnotations || targetFrame.imageData) {
      const [baseImage, mask] = await Promise.all([
        buildFrameBaseImage(targetFrame),
        Promise.resolve(buildTransparentMask(targetFrame.width, targetFrame.height)),
      ]);
      const refs = [...(annotationReference ? [annotationReference] : []), ...contextCaptures];
      const dataUrl = await editImage(baseImage, mask, guidedPrompt, targetFrame.width, targetFrame.height, refs);
      updateObject(targetFrame.id, { url: null, imageData: dataUrl, generating: false, priorBounds: null });
    } else if (contextCaptures.length > 0) {
      const transparentBase = buildTransparentMask(targetFrame.width, targetFrame.height);
      const mask = buildTransparentMask(targetFrame.width, targetFrame.height);
      const dataUrl = await editImage(transparentBase, mask, guidedPrompt, targetFrame.width, targetFrame.height, contextCaptures);
      updateObject(targetFrame.id, { url: null, imageData: dataUrl, generating: false });
    } else {
      const dataUrl = await generateImage(guidedPrompt, targetFrame.width, targetFrame.height);
      updateObject(targetFrame.id, { url: null, imageData: dataUrl, generating: false });
    }
  };

  const generate = async () => {
    if (!prompt.trim()) return;
    setError('');
    if (!hasOpenAiApiKey()) {
      setError('Add your OpenAI API key to generate images.');
      requestOpenAiApiKey();
      return;
    }
    setIsGenerating(true);

    if (!effectiveFrame) {
      // Create a new image frame at viewport center
      const TOOLBAR_W = 64;
      const screenW = window.innerWidth - TOOLBAR_W;
      const screenH = window.innerHeight;
      const wx = (screenW / 2 - stageX) / stageScale - createWidth / 2;
      const wy = (screenH / 2 - stageY) / stageScale - createHeight / 2;
      const newFrame: FrameObject = {
        id: nanoid(),
        type: 'frame',
        kind: 'image',
        x: wx, y: wy,
        width: createWidth,
        height: createHeight,
        label: `Frame ${incrementFrameCount()}`,
        background: '#181818',
        url: null,
        imageData: null,
        generating: true,
        priorBounds: null,
      };
      addObject(newFrame);
      setSelectedIds([newFrame.id]);
      try {
        const contextCaptures = await captureContextFrameImages();
        let dataUrl: string;
        if (contextCaptures.length > 0) {
          const base = buildTransparentMask(createWidth, createHeight);
          const mask = buildTransparentMask(createWidth, createHeight);
          dataUrl = await editImage(base, mask, prompt.trim(), createWidth, createHeight, contextCaptures);
        } else {
          dataUrl = await generateImage(prompt.trim(), createWidth, createHeight);
        }
        updateObject(newFrame.id, { imageData: dataUrl, generating: false });
        setPrompt('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Generation failed');
        updateObject(newFrame.id, { generating: false });
      } finally {
        setIsGenerating(false);
      }
      return;
    }

    try {
      updateObject(effectiveFrame.id, { generating: true });
      await generateIntoFrame(effectiveFrame);
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
      updateObject(effectiveFrame.id, { generating: false });
    } finally {
      setIsGenerating(false);
    }
  };

  const cancelOutpaint = () => {
    if (!effectiveFrame?.priorBounds) return;
    updateObject(effectiveFrame.id, {
      x: effectiveFrame.priorBounds.x,
      y: effectiveFrame.priorBounds.y,
      width: effectiveFrame.priorBounds.width,
      height: effectiveFrame.priorBounds.height,
      priorBounds: null,
    });
    setOutpaintFrameId(null);
    setPrompt('');
    setError('');
  };

  // imageFrame tool with no image frame active → create panel
  if (activeTool === 'imageFrame' && !effectiveFrame) {
    return (
      <>
        <select
          value={selectedRatio}
          onChange={(e) => setSelectedRatio(e.target.value as typeof RATIO_PRESETS[number]['label'])}
          style={{
            background: 'var(--theme-surface)',
            border: '1px solid var(--theme-toolbar-border)',
            borderRadius: 6,
            color: 'var(--theme-text-dim)',
            fontSize: 12,
            padding: '4px 8px',
            cursor: 'pointer',
            outline: 'none',
            flexShrink: 0,
          }}
        >
          {RATIO_PRESETS.map(p => (
            <option key={p.label} value={p.label}>{p.label}</option>
          ))}
        </select>
        <Divider />
        <input
          type="text"
          placeholder="Describe an image..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && generate()}
          style={promptInputStyle}
        />
        <ContextButton
          contextFrameIds={contextFrameIds}
          contextPickerActive={contextPickerActive}
          onToggle={() => setContextPickerActive(!contextPickerActive)}
          onRemove={toggleContextFrame}
          objects={objects}
          iconOnly
        />
        <GenButton onClick={generate} loading={isGenerating} label="Generate" iconOnly />
        {error && <span style={{ fontSize: 11, color: '#ef4444' }}>{error}</span>}
      </>
    );
  }

  if (!frame) {
    return (
      <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>
        Drag on the canvas to create a frame.
      </span>
    );
  }

  const kind = frame.kind ?? 'image';
  const isOutpaint = kind === 'image' && !!effectiveFrame?.priorBounds && !!effectiveFrame?.imageData;
  const hasImage = !!effectiveFrame?.imageData;
  const annotationCount = objects.filter((obj) => obj.type !== 'frame' && obj.parentFrameId === effectiveFrame?.id).length;

  // Plain frame → plain controls
  if (kind === 'plain') {
    return (
      <>
        <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {frame.label}
        </span>
        <Divider />
        <PlainFrameControls frame={frame} />
      </>
    );
  }

  // Site frame → site controls
  if (kind === 'site') {
    return (
      <>
        <FrameUrlControls frame={frame} />
        <Divider />
        <FrameSizeControls frame={frame} />
      </>
    );
  }

  return (
    <>
      <input
        type="text"
        placeholder={isOutpaint ? 'Describe what to add...' : hasImage ? 'describe an edit...' : 'Describe an image...'}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && generate()}
        style={promptInputStyle}
      />
      <ContextButton
        contextFrameIds={contextFrameIds}
        contextPickerActive={contextPickerActive}
        onToggle={() => setContextPickerActive(!contextPickerActive)}
        onRemove={toggleContextFrame}
        objects={objects}
        iconOnly={hasImage}
      />
      <GenButton
        onClick={generate}
        loading={isGenerating}
        label={isOutpaint ? 'Outpaint' : hasImage ? 'Regenerate' : 'Generate'}
        iconOnly={hasImage}
      />
      <Divider />
      <FrameSizeControls frame={frame} />
      {isOutpaint && (
        <button
          onClick={cancelOutpaint}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--theme-text-muted)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 4px',
            borderRadius: 6,
            fontSize: 12,
          }}
          title="Cancel"
        >
          <X size={14} />
        </button>
      )}
    </>
  );
}

function DefaultPanel({ tool }: { tool: string }) {
  const label: Record<string, string> = {
    select: 'Select tool — click objects to select',
    pan: 'Pan tool — drag to navigate',
    frame: 'Frame tool - drag to create a plain frame',
    imageFrame: 'Image tool - drag to create an image object',
    siteFrame: 'Site preview tool - drag to create an embedded site preview',
    line: 'Line tool — drag to draw a line',
  };
  return (
    <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>
      {label[tool] ?? tool}
    </span>
  );
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function Divider() {
  return (
    <div style={{ width: 1, height: 28, background: 'var(--theme-toolbar-border)', flexShrink: 0 }} />
  );
}

const promptInputStyle: React.CSSProperties = {
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-input-border)',
  borderRadius: 8,
  color: 'var(--theme-text)',
  fontSize: 13,
  padding: '6px 12px',
  outline: 'none',
  width: 240,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: 'var(--theme-surface)',
  border: '1px solid var(--theme-input-border)',
  borderRadius: 8,
  color: 'var(--theme-text)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 10px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

function ContextButton({
  contextFrameIds,
  contextPickerActive,
  onToggle,
  onRemove,
  objects,
  iconOnly,
}: {
  contextFrameIds: string[];
  contextPickerActive: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  objects: CanvasObject[];
  iconOnly?: boolean;
}) {
  const count = contextFrameIds.length;
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={onToggle}
        title="Add context frames — click frames on canvas when open"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: iconOnly ? '6px 7px' : '6px 10px',
          borderRadius: 8,
          border: contextPickerActive ? '1px solid #14b8a6' : count > 0 ? '1px solid #5eead4' : '1px solid var(--theme-input-border)',
          background: contextPickerActive ? 'rgba(20,184,166,0.12)' : 'var(--theme-surface)',
          color: contextPickerActive ? '#14b8a6' : count > 0 ? '#0d9488' : 'var(--theme-text-muted)',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <Layers size={13} />
        {!iconOnly && (count > 0 ? `Context (${count})` : 'Context')}
      </button>

      {contextPickerActive && (
        <div
          style={{
            position: 'absolute',
            bottom: 44,
            left: 0,
            background: 'var(--theme-menu-bg)',
            border: '1px solid var(--theme-toolbar-border)',
            borderRadius: 10,
            padding: '8px 10px',
            minWidth: 200,
            zIndex: 100,
            boxShadow: '0 -8px 24px rgba(0,0,0,0.2)',
          }}
        >
          {count === 0 && (
            <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>Click frames on canvas to add</div>
          )}
          {contextFrameIds.map((id) => {
            const f = objects.find((o): o is FrameObject => o.type === 'frame' && o.id === id);
            if (!f) return null;
            return (
              <div
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '3px 0',
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--theme-text-dim)' }}>{f.label}</span>
                <button
                  onClick={() => onRemove(id)}
                  style={{ background: 'none', border: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontSize: 15 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GenButton({ onClick, loading, label, iconOnly }: { onClick: () => void; loading: boolean; label: string; iconOnly?: boolean }) {
  const icon = loading
    ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
    : iconOnly ? <ArrowRight size={15} /> : <Wand2 size={14} />;
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: iconOnly ? '6px 8px' : '6px 14px',
        borderRadius: 8,
        border: 'none',
        background: loading ? 'var(--theme-surface)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {icon}
      {!iconOnly && label}
    </button>
  );
}

// ─── Main BottomBar ───────────────────────────────────────────────────────────

export default function BottomBar() {
  const { tool, selectedIds, objects, outpaintFrameId } = useCanvasStore();

  const selectedObjects = selectedIds
    .map((id) => objects.find((o) => o.id === id))
    .filter((obj): obj is CanvasObject => !!obj);
  const selectedObj = selectedObjects.length === 1 ? selectedObjects[0] : undefined;
  const selectedFrame = selectedObj?.type === 'frame' ? (selectedObj as FrameObject) : undefined;

  // Inpaint: selected frame (no image) overlaps a background frame that has an image
  const inpaintTarget = selectedFrame && (selectedFrame.kind ?? 'image') === 'image' && !selectedFrame.imageData
    ? objects.find((o): o is FrameObject => {
        if (o.type !== 'frame' || o.id === selectedFrame.id || !o.imageData) return false;
        return (
          selectedFrame.x < o.x + o.width  && selectedFrame.x + selectedFrame.width  > o.x &&
          selectedFrame.y < o.y + o.height && selectedFrame.y + selectedFrame.height > o.y
        );
      })
    : undefined;

  // Outpaint: triggered explicitly or when the selected frame has priorBounds (re-selected)
  const outpaintFrame = objects.find((o): o is FrameObject =>
    o.type === 'frame' && o.id === outpaintFrameId,
  );
  const activeFrame = selectedFrame ?? outpaintFrame;

  const showFrameTool = isFrameTool(tool) && (tool === 'imageFrame' || !!activeFrame);
  const showSelected  = !showFrameTool && tool === 'select' && canShowMultiSelectedPanel(selectedObjects);
  const showPen       = !showFrameTool && !showSelected && tool === 'pen';
  const showShape     = !showFrameTool && !showSelected && (tool === 'rect' || tool === 'ellipse');
  const showArrow     = !showFrameTool && !showSelected && (tool === 'arrow' || tool === 'line');
  const showText      = !showFrameTool && !showSelected && tool === 'text';
  const showDefault   = !showFrameTool && !showSelected && !showPen && !showShape && !showArrow && !showText && tool !== 'select' && tool !== 'pan' && tool !== 'eraser';

  const hasContent = showSelected || showPen || showShape || showArrow || showText || showFrameTool || showDefault;
  if (!hasContent) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          background: 'var(--theme-panel-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--theme-panel-border)',
          borderRadius: 16,
          padding: '10px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          boxShadow: 'none',
          minHeight: 52,
        }}
      >
        {showSelected && <SelectedObjectsPanel objects={selectedObjects} />}
        {showPen && <PenPanel />}
        {showShape && <ShapePanel />}
        {showArrow && <ArrowPanel />}
        {showText && <TextPanel />}
        {showFrameTool && <FrameToolPanel frame={activeFrame} tool={tool} />}
        {showDefault && <DefaultPanel tool={tool} />}
      </div>

      {/* Keyframe spinner animation */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .animate-spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  );
}
