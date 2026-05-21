import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToolType } from '../types/canvas';

// ─── Color utilities ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (!m) return null;
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function colorToHsl(color: string): [number, number, number] {
  const rgb = hexToRgb(color);
  if (!rgb) return [0, 0, 50];
  return rgbToHsl(...rgb);
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

function wedgePath(cx: number, cy: number, ir: number, or: number, sa: number, ea: number): string {
  const gap = 0.035;
  const s = sa + gap, e = ea - gap;
  const large = (e - s) > Math.PI ? 1 : 0;
  const c1 = Math.cos(s), s1 = Math.sin(s);
  const c2 = Math.cos(e), s2 = Math.sin(e);
  return [
    `M${cx + ir * c1},${cy + ir * s1}`,
    `L${cx + or * c1},${cy + or * s1}`,
    `A${or},${or},0,${large},1,${cx + or * c2},${cy + or * s2}`,
    `L${cx + ir * c2},${cy + ir * s2}`,
    `A${ir},${ir},0,${large},0,${cx + ir * c1},${cy + ir * s1}Z`,
  ].join('');
}

function arcSegment(cx: number, cy: number, r: number, sa: number, ea: number): string {
  const large = (ea - sa) > Math.PI ? 1 : 0;
  return `M${cx + r * Math.cos(sa)},${cy + r * Math.sin(sa)}A${r},${r},0,${large},1,${cx + r * Math.cos(ea)},${cy + r * Math.sin(ea)}`;
}

// ─── Param config ─────────────────────────────────────────────────────────────

type ControlMode = 'angular' | 'radial';

interface ParamConfig {
  id: string;
  label: string;
  short: string;
  color: string;
  min: number;
  max: number;
  format: (v: number) => string;
  controlMode: ControlMode;
  cyclic?: boolean;
}

const PARAMS: Record<string, ParamConfig> = {
  size:       { id: 'size',       label: 'Size',       short: 'W', color: '#818cf8', min: 1,   max: 80,  format: v => `${Math.round(v)}`,  controlMode: 'radial' },
  opacity:    { id: 'opacity',    label: 'Opacity',    short: 'A', color: '#94a3b8', min: 5,   max: 100, format: v => `${Math.round(v)}%`, controlMode: 'radial' },
  hue:        { id: 'hue',        label: 'Hue',        short: 'H', color: '#f87171', min: 0,   max: 360, format: v => `${Math.round(v)}°`, controlMode: 'angular', cyclic: true },
  saturation: { id: 'saturation', label: 'Saturation', short: 'S', color: '#34d399', min: 0,   max: 100, format: v => `${Math.round(v)}%`, controlMode: 'radial' },
  lightness:  { id: 'lightness',  label: 'Lightness',  short: 'L', color: '#fbbf24', min: 0,   max: 100, format: v => `${Math.round(v)}%`, controlMode: 'radial' },
};

const TOOL_PARAMS: Partial<Record<ToolType, string[]>> = {
  pen:    ['size', 'opacity', 'hue', 'saturation', 'lightness'],
  eraser: ['size'],
};

// ─── Radii ────────────────────────────────────────────────────────────────────

const OR = 112; // outer ring radius
const IR = 36;  // inner disc radius
const DWELL_MS = 120;

// ─── Wedge view ───────────────────────────────────────────────────────────────

function WedgeView({ cx, cy, params, activeId, brushColor, brushSize, brushOpacity }: {
  cx: number; cy: number;
  params: ParamConfig[];
  activeId: string | null;
  brushColor: string; brushSize: number; brushOpacity: number;
}) {
  const N = params.length;
  const wa = TWO_PI / N;
  const labelR = (IR + OR) / 2;
  const dotR = Math.min(IR - 9, Math.max(6, brushSize / 2));

  return (
    <g>
      <circle cx={cx} cy={cy} r={OR + 10} fill="rgba(0,0,0,0.38)" />
      {params.map((p, i) => {
        const sa = -HALF_PI + i * wa;
        const ea = sa + wa;
        const ma = sa + wa / 2;
        const active = p.id === activeId;
        return (
          <g key={p.id}>
            <path
              d={wedgePath(cx, cy, IR, OR, sa, ea)}
              fill={p.color}
              fillOpacity={active ? 0.78 : 0.18}
              stroke={active ? p.color : 'rgba(255,255,255,0.05)'}
              strokeWidth={active ? 1.5 : 1}
            />
            <text
              x={cx + labelR * Math.cos(ma)}
              y={cy + labelR * Math.sin(ma)}
              textAnchor="middle" dominantBaseline="central"
              fill={active ? '#fff' : 'rgba(255,255,255,0.5)'}
              fontSize={active ? 13 : 11}
              fontWeight={active ? 700 : 500}
              fontFamily="system-ui, -apple-system, sans-serif"
              style={{ userSelect: 'none', pointerEvents: 'none' }}
            >{p.short}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={IR - 1} fill="rgba(10,10,14,0.96)" stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
      <circle cx={cx} cy={cy} r={dotR} fill={brushColor} fillOpacity={brushOpacity} />
      <circle cx={cx} cy={cy} r={dotR} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
    </g>
  );
}

// ─── Hue wheel view (angular control) ────────────────────────────────────────

// Static rainbow ring — never changes, memoized so it renders exactly once.
const HueRing = memo(function HueRing({ cx, cy }: { cx: number; cy: number }) {
  const ringR = OR - 6;
  const segs = 60;
  const dA = TWO_PI / segs;
  return (
    <>
      <circle cx={cx} cy={cy} r={OR + 10} fill="rgba(0,0,0,0.5)" />
      <circle cx={cx} cy={cy} r={OR} fill="rgba(10,10,14,0.94)" />
      {Array.from({ length: segs }, (_, i) => {
        const sa = -HALF_PI + i * dA;
        const ea = sa + dA + 0.02;
        return (
          <path key={i}
            d={arcSegment(cx, cy, ringR, sa, ea)}
            fill="none"
            stroke={`hsl(${(i / segs) * 360},75%,58%)`}
            strokeWidth={9}
          />
        );
      })}
    </>
  );
});

function HueWheelView({ cx, cy, value, initialValue, entryAngle, hueRotOffset, cursorAngle, brushColor, brushSize, brushOpacity }: {
  cx: number; cy: number; value: number; initialValue: number;
  entryAngle: number; hueRotOffset: number; cursorAngle: number;
  brushColor: string; brushSize: number; brushOpacity: number;
}) {
  const ringR = OR - 6;
  const discR = IR + 4;
  const hueCss = `hsl(${Math.round(value)},75%,58%)`;
  const dotR = Math.min(discR - 9, Math.max(6, brushSize / 2));

  // Rotate the ring SVG so the initial hue sits at the cursor's entry angle.
  // rotOffset = initialHue/360*2π - entryAngle - π/2  →  ring visual rotation = -rotOffset (radians → degrees)
  const ringRotDeg = -hueRotOffset * (180 / Math.PI);

  // Current handle position
  const hx = cx + ringR * Math.cos(cursorAngle);
  const hy = cy + ringR * Math.sin(cursorAngle);

  // Initial value sits at entryAngle after the ring rotation
  const prevX = cx + ringR * Math.cos(entryAngle);
  const prevY = cy + ringR * Math.sin(entryAngle);

  return (
    <g>
      {/* Rainbow ring, rotated so initial hue aligns with entry cursor */}
      <g transform={`rotate(${ringRotDeg}, ${cx}, ${cy})`}>
        <HueRing cx={cx} cy={cy} />
      </g>

      {/* Spoke lines drawn over the ring, covered at center by inner disc */}
      {/* Previous value spoke (dashed white) */}
      <line x1={cx} y1={cy} x2={prevX} y2={prevY}
        stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} strokeDasharray="5 3" />
      {/* Current value spoke (solid, hue color) */}
      <line x1={cx} y1={cy} x2={hx} y2={hy}
        stroke={hueCss} strokeWidth={2.5} opacity={0.9} />

      {/* Ring markers */}
      <circle cx={prevX} cy={prevY} r={5}
        fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} strokeDasharray="2 2" />
      <circle cx={hx} cy={hy} r={8} fill={hueCss} stroke="#fff" strokeWidth={2} />

      {/* Inner disc (covers spoke centers) */}
      <circle cx={cx} cy={cy} r={discR} fill="rgba(10,10,14,0.96)" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

      {/* Brush preview */}
      <circle cx={cx} cy={cy} r={dotR} fill={brushColor} fillOpacity={brushOpacity} />
      <circle cx={cx} cy={cy} r={dotR} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />

      {/* Labels at bottom of disc */}
      <text x={cx} y={cy + discR - 14} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.38)" fontSize={7}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >HUE</text>
      <text x={cx} y={cy + discR - 4} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.85)" fontSize={11} fontWeight={600}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >{Math.round(value)}°</text>
    </g>
  );
}

// ─── Radial spoke view (linear control) ──────────────────────────────────────

function SpokeView({ cx, cy, param, value, initialValue, entryAngle, cursorDist, brushColor, brushSize, brushOpacity }: {
  cx: number; cy: number;
  param: ParamConfig;
  value: number;
  initialValue: number;
  entryAngle: number;
  cursorDist: number;
  brushColor: string;
  brushSize: number;
  brushOpacity: number;
}) {
  const range = param.max - param.min;
  const normalized = Math.min(1, Math.max(0, (value - param.min) / range));
  const initNorm   = Math.min(1, Math.max(0, (initialValue - param.min) / range));
  const dotR = Math.min(IR - 9, Math.max(6, brushSize / 2));

  // Spoke direction locked at entry angle
  const cosA = Math.cos(entryAngle), sinA = Math.sin(entryAngle);

  // Spoke endpoints
  const spokeStartX = cx + IR * cosA, spokeStartY = cy + IR * sinA;
  const spokeEndX   = cx + OR * cosA, spokeEndY   = cy + OR * sinA;

  // Large concentric ring radii
  const currentR = IR + normalized * (OR - IR);
  const initR    = IR + initNorm    * (OR - IR);

  // Cursor dot clamped to spoke range
  const clampedDist = Math.min(OR, Math.max(IR, cursorDist));
  const curX = cx + clampedDist * cosA, curY = cy + clampedDist * sinA;

  // Tick marks at 25%, 50%, 75%
  const tickLen = 5;
  const perpX = -sinA, perpY = cosA;
  const ticks = [0.25, 0.5, 0.75].map(t => {
    const r = IR + t * (OR - IR);
    return {
      x1: cx + r * cosA - perpX * tickLen, y1: cy + r * sinA - perpY * tickLen,
      x2: cx + r * cosA + perpX * tickLen, y2: cy + r * sinA + perpY * tickLen,
    };
  });

  const minLabelX = cx + (IR - 12) * cosA, minLabelY = cy + (IR - 12) * sinA;
  const maxLabelX = cx + (OR + 12) * cosA, maxLabelY = cy + (OR + 12) * sinA;

  return (
    <g>
      {/* Range boundary guides */}
      <circle cx={cx} cy={cy} r={IR} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
      <circle cx={cx} cy={cy} r={OR} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1} />

      {/* Initial value ring — large dashed circle around whole menu */}
      <circle cx={cx} cy={cy} r={initR}
        fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={1.5} strokeDasharray="4 4" />

      {/* Current value ring — large solid circle around whole menu */}
      <circle cx={cx} cy={cy} r={currentR}
        fill="none" stroke={param.color} strokeWidth={2.5} opacity={0.7} />

      {/* Spoke track */}
      <line x1={spokeStartX} y1={spokeStartY} x2={spokeEndX} y2={spokeEndY}
        stroke="rgba(255,255,255,0.12)" strokeWidth={2} strokeLinecap="round" />

      {/* Filled portion of spoke (from min to cursor) */}
      <line x1={spokeStartX} y1={spokeStartY} x2={curX} y2={curY}
        stroke={param.color} strokeWidth={3} strokeLinecap="round" />

      {/* Tick marks */}
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} strokeLinecap="round" />
      ))}

      {/* End dots */}
      <circle cx={spokeStartX} cy={spokeStartY} r={3} fill="rgba(255,255,255,0.2)" />
      <circle cx={spokeEndX}   cy={spokeEndY}   r={3} fill="rgba(255,255,255,0.2)" />

      {/* Cursor dot on spoke */}
      <circle cx={curX} cy={curY} r={7}
        fill={param.color} stroke="#fff" strokeWidth={1.5} />

      {/* Center disc */}
      <circle cx={cx} cy={cy} r={IR - 1} fill="rgba(10,10,14,0.96)" stroke="rgba(255,255,255,0.07)" strokeWidth={1} />

      {/* Brush preview — actual color, opacity, and relative size */}
      <circle cx={cx} cy={cy} r={dotR} fill={brushColor} fillOpacity={brushOpacity} />
      <circle cx={cx} cy={cy} r={dotR} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />

      {/* Labels anchored to bottom of disc */}
      <text x={cx} y={cy + IR - 15} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.38)" fontSize={7}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >{param.label.toUpperCase()}</text>
      <text x={cx} y={cy + IR - 5} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.85)" fontSize={11} fontWeight={600}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >{param.format(value)}</text>

      {/* Min/max labels */}
      <text x={minLabelX} y={minLabelY} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.28)" fontSize={8}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >{param.format(param.min)}</text>
      <text x={maxLabelX} y={maxLabelY} textAnchor="middle" dominantBaseline="central"
        fill="rgba(255,255,255,0.28)" fontSize={8}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >{param.format(param.max)}</text>
    </g>
  );
}

// ─── Phase types ──────────────────────────────────────────────────────────────

type WedgePhase  = { kind: 'wedge'; activeId: string | null };
type AdjustPhase = {
  kind: 'adjust';
  paramId: string;
  value: number;
  initialValue: number;  // value on entry — restored if user cancels by returning to center
  entryAngle: number;    // spoke direction locked at entry (linear params stay visually fixed)
  hueRotOffset: number;  // angular offset so initial hue aligns with entry cursor position
  cursorAngle: number;   // live cursor angle (used by hue wheel handle)
  cursorDist: number;
};
type Phase = WedgePhase | AdjustPhase;

// ─── Main component ───────────────────────────────────────────────────────────

export interface RadialMenuProps {
  cx: number;
  cy: number;
  tool: ToolType;
  brushColor: string;
  brushSize: number;
  brushOpacity: number;
  setBrushColor: (c: string) => void;
  setBrushSize: (s: number) => void;
  setBrushOpacity: (o: number) => void;
  onDismiss: () => void;
}

export default function RadialMenu({
  cx, cy, tool,
  brushColor, brushSize, brushOpacity,
  setBrushColor, setBrushSize, setBrushOpacity,
  onDismiss,
}: RadialMenuProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayOrigin = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const cursorGroupRef = useRef<SVGGElement>(null);
  const hslRef = useRef<[number, number, number]>(colorToHsl(brushColor));

  // Cache bounding rect once on mount — the overlay fills the container and never moves.
  useEffect(() => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (rect) overlayOrigin.current = { left: rect.left, top: rect.top };
  }, []);

  const paramIds = TOOL_PARAMS[tool] ?? ['size'];
  const params = paramIds.map(id => PARAMS[id]).filter(Boolean);
  const N = params.length;
  const wedgeAngle = TWO_PI / N;

  const [phase, setPhase] = useState<Phase>({ kind: 'wedge', activeId: null });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // ── Close on right-click release ──────────────────────────────────────────
  // Stable ref so window listeners never hold a stale closure.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const onPointerUp   = (e: PointerEvent) => { if (e.button === 2) onDismissRef.current(); };
    const onMouseUp     = (e: MouseEvent)   => { if (e.button === 2) onDismissRef.current(); };
    // contextmenu fires on right-click release on Windows (and in some Wacom driver modes)
    const onContextMenu = () => onDismissRef.current();
    window.addEventListener('pointerup',    onPointerUp);
    window.addEventListener('mouseup',      onMouseUp);
    window.addEventListener('contextmenu',  onContextMenu);
    return () => {
      window.removeEventListener('pointerup',   onPointerUp);
      window.removeEventListener('mouseup',     onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  // ── Value accessors ────────────────────────────────────────────────────────

  const getValue = useCallback((id: string): number =>
    getInitialValue(id, brushSize, brushOpacity, hslRef.current),
  [brushSize, brushOpacity]);

  const applyValue = useCallback((id: string, raw: number): number => {
    const cfg = PARAMS[id];
    if (!cfg) return raw;
    const v = cfg.cyclic
      ? ((raw % cfg.max) + cfg.max) % cfg.max
      : Math.min(cfg.max, Math.max(cfg.min, raw));
    if (id === 'size') setBrushSize(Math.round(v));
    else if (id === 'opacity') setBrushOpacity(v / 100);
    else if (id === 'hue')        { hslRef.current = [v, hslRef.current[1], hslRef.current[2]]; setBrushColor(hslToHex(...hslRef.current)); }
    else if (id === 'saturation') { hslRef.current = [hslRef.current[0], v, hslRef.current[2]]; setBrushColor(hslToHex(...hslRef.current)); }
    else if (id === 'lightness')  { hslRef.current = [hslRef.current[0], hslRef.current[1], v]; setBrushColor(hslToHex(...hslRef.current)); }
    return v;
  }, [setBrushSize, setBrushOpacity, setBrushColor]);

  // ── Wedge lookup ───────────────────────────────────────────────────────────

  const getWedgeId = useCallback((angle: number): string | null => {
    const norm = ((angle + HALF_PI) % TWO_PI + TWO_PI) % TWO_PI;
    const i = Math.floor(norm / wedgeAngle);
    return params[i]?.id ?? null;
  }, [params, wedgeAngle]);

  // ── Dwell ──────────────────────────────────────────────────────────────────

  const dwellRef = useRef<number | null>(null);
  const clearDwell = useCallback(() => {
    if (dwellRef.current != null) { window.clearTimeout(dwellRef.current); dwellRef.current = null; }
  }, []);
  useEffect(() => clearDwell, [clearDwell]);

  // ── Enter adjust mode ──────────────────────────────────────────────────────

  const enterAdjust = useCallback((id: string, angle: number, dist: number) => {
    clearDwell();
    const cfg = PARAMS[id];
    if (!cfg) return;
    if (['hue', 'saturation', 'lightness'].includes(id)) {
      hslRef.current = colorToHsl(brushColor);
    }
    const initialValue = getValue(id);
    // For hue: rotate the ring so the initial hue sits at the cursor's entry position.
    // rotOffset shifts the angle-to-hue mapping so cursor at entryAngle → initialValue.
    const hueRotOffset = id === 'hue'
      ? (initialValue / 360) * TWO_PI - angle - HALF_PI
      : 0;
    const value = computeValue(cfg, angle, dist, hueRotOffset);
    applyValue(id, value);
    setPhase({ kind: 'adjust', paramId: id, value, initialValue, entryAngle: angle, hueRotOffset, cursorAngle: angle, cursorDist: dist });
  }, [clearDwell, brushColor, getValue, applyValue]);

  // ── Local coord helper (used by handleDown only) ──────────────────────────

  const getLocal = useCallback((e: React.PointerEvent<HTMLDivElement>) => ({
    x: e.clientX - overlayOrigin.current.left,
    y: e.clientY - overlayOrigin.current.top,
  }), []);

  // ── RAF refs ───────────────────────────────────────────────────────────────
  const pendingAdjust = useRef<{ angle: number; dist: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  // ── Window-level pointermove ───────────────────────────────────────────────
  // Konva calls setPointerCapture on the canvas when the stylus touches down,
  // so onPointerMove on the overlay div never fires for pen events. Window
  // listeners still receive captured events because they bubble to window.
  // We use a mutable context ref so the listener is registered exactly once.
  const moveCtxRef = useRef({ cx, cy, N, getWedgeId, enterAdjust, applyValue, clearDwell });
  moveCtxRef.current = { cx, cy, N, getWedgeId, enterAdjust, applyValue, clearDwell };

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const ctx = moveCtxRef.current;
      const px = e.clientX - overlayOrigin.current.left;
      const py = e.clientY - overlayOrigin.current.top;

      // Update SVG cursor directly — no React state, no re-render
      if (cursorGroupRef.current) {
        cursorGroupRef.current.setAttribute('transform', `translate(${px},${py})`);
        if (e.pointerType !== 'pen') cursorGroupRef.current.setAttribute('visibility', 'visible');
      }

      const dx = px - ctx.cx, dy = py - ctx.cy;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const p = phaseRef.current;

      if (p.kind === 'wedge') {
        if (dist < IR - 2) {
          ctx.clearDwell();
          if (p.activeId !== null) setPhase({ kind: 'wedge', activeId: null });
          return;
        }
        const hovered = ctx.getWedgeId(angle);
        if (hovered !== p.activeId) {
          ctx.clearDwell();
          setPhase({ kind: 'wedge', activeId: hovered });
          if (hovered) {
            const delay = ctx.N === 1 ? 0 : DWELL_MS;
            dwellRef.current = window.setTimeout(() => {
              dwellRef.current = null;
              moveCtxRef.current.enterAdjust(hovered, angle, dist);
            }, delay);
          }
        }
      } else {
        // Returning inside the center disc cancels and restores the previous value
        if (dist < IR - 2) {
          if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
          pendingAdjust.current = null;
          const cur = phaseRef.current;
          if (cur.kind === 'adjust') {
            ctx.applyValue(cur.paramId, cur.initialValue);
            setPhase({ kind: 'wedge', activeId: null });
          }
          return;
        }
        // Buffer the latest position; RAF drains it at ~60 fps
        pendingAdjust.current = { angle, dist };
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const pending = pendingAdjust.current;
            pendingAdjust.current = null;
            if (!pending) return;
            const cur = phaseRef.current;
            if (cur.kind !== 'adjust') return;
            const cfg = PARAMS[cur.paramId];
            if (!cfg) return;
            const value = computeValue(cfg, pending.angle, pending.dist, cur.hueRotOffset);
            moveCtxRef.current.applyValue(cur.paramId, value);
            setPhase({ ...cur, value, cursorAngle: pending.angle, cursorDist: pending.dist });
          });
        }
      }
    };
    window.addEventListener('pointermove', handler);
    return () => window.removeEventListener('pointermove', handler);
  }, []); // registered once; reads fresh state through moveCtxRef / phaseRef

  // ── Pointer down — left-click enters hovered wedge; right-click dismisses ─

  const handleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button === 2) { e.preventDefault(); onDismiss(); return; }
    const p = phaseRef.current;
    if (p.kind === 'wedge' && p.activeId) {
      const { x: px, y: py } = getLocal(e);
      enterAdjust(p.activeId, Math.atan2(py - cy, px - cx), Math.hypot(px - cx, py - cy));
    } else if (p.kind === 'wedge') {
      onDismiss();
    }
    // In adjust phase, left-click does nothing (right-click or release dismisses)
  }, [cx, cy, getLocal, enterAdjust, onDismiss]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={overlayRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'all', zIndex: 50, cursor: 'none' }}
      onPointerDown={handleDown}
      onPointerUp={(e) => { if (e.button === 2) onDismiss(); }}
      onMouseUp={(e) => { if (e.button === 2) onDismiss(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width="100%" height="100%">
        {phase.kind === 'wedge' ? (
          <WedgeView
            cx={cx} cy={cy}
            params={params}
            activeId={phase.activeId}
            brushColor={brushColor}
            brushSize={brushSize}
            brushOpacity={brushOpacity}
          />
        ) : PARAMS[phase.paramId]?.controlMode === 'angular' ? (
          <HueWheelView
            cx={cx} cy={cy}
            value={phase.value}
            initialValue={phase.initialValue}
            entryAngle={phase.entryAngle}
            hueRotOffset={phase.hueRotOffset}
            cursorAngle={phase.cursorAngle}
            brushColor={brushColor}
            brushSize={brushSize}
            brushOpacity={brushOpacity}
          />
        ) : (
          <SpokeView
            cx={cx} cy={cy}
            param={PARAMS[phase.paramId]}
            value={phase.value}
            initialValue={phase.initialValue}
            entryAngle={phase.entryAngle}
            cursorDist={phase.cursorDist}
            brushColor={brushColor}
            brushSize={brushSize}
            brushOpacity={brushOpacity}
          />
        )}
        {/* SVG cursor — positioned via direct DOM mutation, hidden for pen input */}
        <g ref={cursorGroupRef} visibility="hidden" style={{ pointerEvents: 'none' }}>
          <circle r={5} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2.5} />
          <circle r={5} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1} />
          <circle r={1.5} fill="rgba(255,255,255,0.9)" />
        </g>
      </svg>
    </div>
  );
}

// ─── Pure helpers (outside component to avoid hook rules) ─────────────────────

function getInitialValue(
  id: string,
  brushSize: number,
  brushOpacity: number,
  hsl: [number, number, number],
): number {
  if (id === 'size') return brushSize;
  if (id === 'opacity') return Math.round(brushOpacity * 100);
  if (id === 'hue') return hsl[0];
  if (id === 'saturation') return hsl[1];
  if (id === 'lightness') return hsl[2];
  return 0;
}

function computeValue(cfg: ParamConfig, angle: number, dist: number, rotOffset = 0): number {
  if (cfg.controlMode === 'angular') {
    const norm = ((angle + rotOffset + HALF_PI) % TWO_PI + TWO_PI) % TWO_PI;
    return norm / TWO_PI * cfg.max;
  } else {
    // Distance from center maps to value; IR = min, OR = max
    const norm = Math.min(1, Math.max(0, (dist - IR) / (OR - IR)));
    return cfg.min + norm * (cfg.max - cfg.min);
  }
}
