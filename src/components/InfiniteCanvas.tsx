import {
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  Stage,
  Layer,
  Line,
  Rect,
  Ellipse,
  Text,
  Image as KonvaImage,
  Transformer,
  Group,
  Shape,
  Circle,
} from 'react-konva';
import Konva from 'konva';
import useImage from 'use-image';
import { nanoid } from 'nanoid';
import { ScreenshotTarget, useCanvasStore } from '../store/useCanvasStore';
import {
  CanvasObject,
  FrameObject,
  StrokeObject,
  RectObject,
  EllipseObject,
  LineObject,
  ArrowObject,
  TextObject,
} from '../types/canvas';
import { captureFrameFromStage } from '../utils/frameCapture';
import RadialMenu from './RadialMenu';

// ─── Constants ───────────────────────────────────────────────────────────────
const ZOOM_FACTOR = 1.08;
Konva.dragButtons = [0];

function isMiddleButtonEvent(e: Konva.KonvaEventObject<Event>): boolean {
  return 'button' in e.evt && e.evt.button === 1;
}

function setNodeStageCursor(node: Konva.Node, cursor: string): void {
  const container = node.getStage()?.container();
  if (container) container.style.cursor = cursor;
}

function normalizedPressure(evt: PointerEvent): number {
  if (evt.pointerType !== 'pen') return 1;
  return Math.min(1, Math.max(0.05, evt.pressure || 0.5));
}

function pressureFactor(pressure: number, min: number): number {
  return min + (1 - min) * pressure;
}

// Returns true only when pressure data contains meaningful variation (i.e. a real
// pen/stylus). Mouse and trackpad always report pressure=1, making all segments
// identical — no need for per-segment rendering in that case.
function hasMeaningfulPressureVariation(pressures: number[]): boolean {
  if (pressures.length < 2) return false;
  const first = pressures[0];
  for (let i = 1; i < pressures.length; i++) {
    if (Math.abs(pressures[i] - first) > 0.05) return true;
  }
  return false;
}

function PressureStrokeLines({
  points,
  pressures,
  color,
  size,
  opacity,
  pressureSize,
  pressureOpacity,
  pressureMin,
}: {
  points: number[];
  pressures?: number[];
  color: string;
  size: number;
  opacity: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureMin?: number;
}) {
  const groupRef = useRef<Konva.Group>(null);

  // After each render, cache the group so all children render to an offscreen
  // canvas at full opacity first, then the group is composited once at the
  // desired opacity. This prevents alpha stacking where overlapping segments
  // (or a self-crossing path) would compound to a higher opacity than intended.
  useEffect(() => {
    if (opacity >= 1) return;
    const group = groupRef.current;
    const layer = group?.getLayer();
    if (!group || !layer) return;
    group.cache();
    layer.batchDraw();
  }, [points, pressures, opacity, color, size, pressureSize, pressureOpacity, pressureMin]);

  // Only use per-segment rendering when pressure actually varies meaningfully.
  // Mouse/trackpad input always returns pressure=1 for every point, so all
  // segments would be identical — N-1 Konva nodes for no visual gain.
  // Fall through to the single-Line path whenever pressure is uniform.
  const usePressure = !!(
    pressures &&
    pressures.length >= points.length / 2 &&
    (pressureSize || pressureOpacity) &&
    hasMeaningfulPressureVariation(pressures)
  );

  if (!usePressure) {
    return (
      <Group ref={groupRef} opacity={opacity}>
        <Line
          points={points}
          stroke={color}
          strokeWidth={size}
          tension={0.4}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(14, size + 8)}
        />
      </Group>
    );
  }

  const min = pressureMin ?? 0.25;
  const segments: JSX.Element[] = [];
  for (let i = 2; i < points.length; i += 2) {
    const pointIndex = i / 2;
    const p = ((pressures[pointIndex - 1] ?? 1) + (pressures[pointIndex] ?? 1)) / 2;
    const factor = pressureFactor(p, min);
    segments.push(
      <Line
        key={i}
        points={[points[i - 2], points[i - 1], points[i], points[i + 1]]}
        stroke={color}
        strokeWidth={pressureSize ? Math.max(0.5, size * factor) : size}
        lineCap="round"
        lineJoin="round"
        hitStrokeWidth={Math.max(14, size + 8)}
      />,
    );
  }

  return (
    <Group ref={groupRef} opacity={opacity}>
      {segments}
    </Group>
  );
}

// Returns true if any eraser point is within striking distance of any stroke point
function strokeHitsEraser(
  strokePts: number[], strokeSz: number,
  eraserPts: number[], eraserSz: number,
): boolean {
  const r2 = ((strokeSz + eraserSz) / 2) ** 2;
  for (let i = 0; i < eraserPts.length; i += 2) {
    const ex = eraserPts[i], ey = eraserPts[i + 1];
    for (let j = 0; j < strokePts.length; j += 2) {
      const dx = ex - strokePts[j], dy = ey - strokePts[j + 1];
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}
// Returns true if any eraser point is within striking distance of any object
function objectHitsEraser(obj: CanvasObject, eraserPts: number[], eraserSz: number): boolean {
  if (obj.type === 'frame') return false;
  if (obj.type === 'stroke') return strokeHitsEraser(obj.points, obj.size, eraserPts, eraserSz);
  const bbox = getBBox(obj);
  if (!bbox) return false;
  const r = eraserSz / 2;
  for (let i = 0; i < eraserPts.length; i += 2) {
    const ex = eraserPts[i], ey = eraserPts[i + 1];
    if (ex >= bbox.x - r && ex <= bbox.x + bbox.w + r &&
        ey >= bbox.y - r && ey <= bbox.y + bbox.h + r) return true;
  }
  return false;
}

// Returns axis-aligned bounding box for any canvas object
function getBBox(obj: CanvasObject): { x: number; y: number; w: number; h: number } | null {
  if (obj.type === 'rect') return { x: obj.x, y: obj.y, w: obj.width, h: obj.height };
  if (obj.type === 'ellipse') return { x: obj.x - obj.radiusX, y: obj.y - obj.radiusY, w: obj.radiusX * 2, h: obj.radiusY * 2 };
  if (obj.type === 'frame') return { x: obj.x, y: obj.y, w: obj.width, h: obj.height };
  if (obj.type === 'line' || obj.type === 'arrow') return { x: Math.min(obj.x1, obj.x2), y: Math.min(obj.y1, obj.y2), w: Math.abs(obj.x2 - obj.x1), h: Math.abs(obj.y2 - obj.y1) };
  if (obj.type === 'text') return { x: obj.x, y: obj.y - obj.fontSize, w: obj.text.length * obj.fontSize * 0.6, h: obj.fontSize * 1.2 };
  if (obj.type === 'comment') return { x: obj.x, y: obj.y - 14, w: obj.text.length * 8.4, h: 18 };
  if (obj.type === 'stroke') {
    if (obj.points.length < 4) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < obj.points.length; i += 2) {
      if (obj.points[i] < minX) minX = obj.points[i];
      if (obj.points[i] > maxX) maxX = obj.points[i];
      if (obj.points[i + 1] < minY) minY = obj.points[i + 1];
      if (obj.points[i + 1] > maxY) maxY = obj.points[i + 1];
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

function expandedBBox(obj: CanvasObject): { x: number; y: number; w: number; h: number } | null {
  const box = getBBox(obj);
  if (!box) return null;
  const pad = obj.type === 'stroke'
    ? Math.max(obj.size, obj.size + 8)
    : obj.type === 'line' || obj.type === 'arrow'
      ? Math.max(obj.strokeWidth, obj.strokeWidth + 10)
      : 0;
  return {
    x: box.x - pad,
    y: box.y - pad,
    w: box.w + pad * 2,
    h: box.h + pad * 2,
  };
}

function getViewportWorldBounds(
  stageX: number,
  stageY: number,
  stageScale: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const scale = stageScale || 1;
  const overscanX = (width / scale) * 2;
  const overscanY = (height / scale) * 2;
  return {
    x: -stageX / scale - overscanX,
    y: -stageY / scale - overscanY,
    w: (width / scale) + overscanX * 2,
    h: (height / scale) + overscanY * 2,
  };
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function findParentFrameIdForBounds(
  bounds: { x: number; y: number; w: number; h: number },
  objects: CanvasObject[],
): string | null {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type !== 'frame') continue;
    if (cx >= obj.x && cx <= obj.x + obj.width && cy >= obj.y && cy <= obj.y + obj.height) {
      return obj.id;
    }
  }
  return null;
}

function getParentFrameIdForObject(obj: CanvasObject, objects: CanvasObject[]): string | null {
  if (obj.type === 'frame') return null;
  const bounds = getBBox(obj);
  return bounds ? findParentFrameIdForBounds(bounds, objects) : null;
}

function shiftCanvasObject(obj: CanvasObject, dx: number, dy: number): Partial<CanvasObject> {
  if (obj.type === 'rect') return { x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'ellipse') return { x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'text') return { x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'line' || obj.type === 'arrow') {
    return {
      x1: obj.x1 + dx, y1: obj.y1 + dy,
      x2: obj.x2 + dx, y2: obj.y2 + dy,
      ...(obj.type === 'arrow' && obj.cx != null ? { cx: obj.cx + dx, cy: obj.cy! + dy } : {}),
    };
  }
  if (obj.type === 'stroke') {
    const shift = (pts: number[]) => pts.map((v, i) => i % 2 === 0 ? v + dx : v + dy);
    return { points: shift(obj.points) };
  }
  if (obj.type === 'frame') {
    return {
      x: obj.x + dx,
      y: obj.y + dy,
      priorBounds: obj.priorBounds ? {
        x: obj.priorBounds.x + dx,
        y: obj.priorBounds.y + dy,
        width: obj.priorBounds.width,
        height: obj.priorBounds.height,
      } : null,
    };
  }
  return {};
}

const MIN_SCALE = 0.03;
const MAX_SCALE = 40;
const TOOLBAR_W = 64;

const FRAME_TOOLS = ['frame', 'imageFrame', 'siteFrame'] as const;
const CANVAS_CLIPBOARD_MIME = 'application/x-canvas-objects';
const PASTE_OFFSET = 24;
const MAX_PASTED_IMAGE_SIZE = 640;

function isFrameTool(tool: string): boolean {
  return FRAME_TOOLS.includes(tool as (typeof FRAME_TOOLS)[number]);
}

function frameKindForTool(tool: string): FrameObject['kind'] {
  if (tool === 'imageFrame') return 'image';
  if (tool === 'siteFrame') return 'site';
  return 'plain';
}

function objectWithUpdates(obj: CanvasObject, updates: Partial<CanvasObject>): CanvasObject {
  return { ...obj, ...updates } as CanvasObject;
}

function cloneCanvasObject(obj: CanvasObject, id: string, parentFrameId?: string | null): CanvasObject {
  const clone = { ...obj, id } as CanvasObject;
  if (clone.type !== 'frame') {
    clone.parentFrameId = parentFrameId ?? null;
  }
  return clone;
}

function duplicateCanvasObjects(
  sourceObjects: CanvasObject[],
  allObjects: CanvasObject[],
  anchor?: { x: number; y: number },
): CanvasObject[] {
  if (sourceObjects.length === 0) return [];

  const boxes = sourceObjects
    .map(getBBox)
    .filter(Boolean) as { x: number; y: number; w: number; h: number }[];
  if (boxes.length === 0) return [];

  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const dx = anchor ? anchor.x - minX : PASTE_OFFSET;
  const dy = anchor ? anchor.y - minY : PASTE_OFFSET;
  const idMap = new Map(sourceObjects.map((obj) => [obj.id, nanoid()]));

  const clones = sourceObjects.map((obj) => {
    const originalParentId = obj.type === 'frame' ? null : obj.parentFrameId ?? null;
    const parentFrameId = originalParentId && idMap.has(originalParentId)
      ? idMap.get(originalParentId)!
      : null;
    return objectWithUpdates(
      cloneCanvasObject(obj, idMap.get(obj.id)!, parentFrameId),
      shiftCanvasObject(obj, dx, dy),
    );
  });

  return clones.map((obj) => {
    if (obj.type === 'frame') return obj;
    if (obj.parentFrameId) return obj;
    return {
      ...obj,
      parentFrameId: getParentFrameIdForObject(obj, [...allObjects, ...clones]),
    } as CanvasObject;
  });
}

function readClipboardImage(item: DataTransferItem): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const file = item.getAsFile();
  if (!file) return Promise.resolve(null);

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const image = new window.Image();
      image.onerror = () => resolve(null);
      image.onload = () => resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

// ─── Live-shape type (shared between move/up) ─────────────────────────────────
interface LiveShape {
  type: 'rect' | 'ellipse' | 'line' | 'arrow';
  // For rect/ellipse: bounding box (top-left + size)
  // For line/arrow:   x,y = raw end position; w,h unused
  x: number; y: number; w: number; h: number;
}

interface SelRect { x: number; y: number; w: number; h: number; }
interface TouchPoint { x: number; y: number; }
interface TouchGesture { centerX: number; centerY: number; distance: number | null; }
type ObjectPointerEvent = Konva.KonvaEventObject<MouseEvent | TouchEvent | PointerEvent | DragEvent>;
type ObjectDragEvent = Konva.KonvaEventObject<DragEvent>;

interface MultiDragState {
  draggedId: string;
  selectedIds: string[];
  targetStart: { x: number; y: number };
  objects: CanvasObject[];
  nodeStarts: Record<string, { x: number; y: number }>;
  imageStarts: Record<string, { x: number; y: number }>;
}

interface FrameChildDragState {
  frameId: string;
  frameStart: { x: number; y: number };
  childStarts: Record<string, { x: number; y: number }>;
}

// ─── StrokeRenderer ──────────────────────────────────────────────────────────

function StrokeRenderer({
  obj,
  isSelected,
  tool,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}: {
  obj: StrokeObject;
  isSelected: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}) {
  if (obj.points.length < 4) return null;

  return (
    <Group
      id={obj.id}
      draggable={tool === 'select'}
      onPointerDown={onSelect}
      onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
      onDragMove={onDragMove}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
      onTransformEnd={onTransformEnd}
      onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
      onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
    >
      <PressureStrokeLines
        points={obj.points}
        pressures={obj.pressures}
        color={obj.color}
        size={obj.size}
        opacity={obj.opacity}
        pressureSize={obj.pressureSize}
        pressureOpacity={obj.pressureOpacity}
        pressureMin={obj.pressureMin}
      />
    </Group>
  );
}

// ─── RectRenderer ────────────────────────────────────────────────────────────

function RectRenderer({
  obj, isSelected, tool, onSelect, onDragStart, onDragMove, onTransformEnd, onDragEnd,
}: {
  obj: RectObject;
  isSelected: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  const isTransparent = obj.fill === 'transparent';
  return (
    <Rect
      id={obj.id}
      x={obj.x} y={obj.y}
      width={obj.width} height={obj.height}
      fill={isTransparent ? undefined : obj.fill}
      stroke={obj.stroke}
      strokeWidth={obj.strokeWidth}
      opacity={obj.opacity}
      cornerRadius={obj.cornerRadius}
      draggable={tool === 'select'}
      onPointerDown={onSelect}
      onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
      onDragMove={onDragMove}
      onClick={onSelect} onTap={onSelect}
      onTransformEnd={onTransformEnd}
      onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
      onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
      onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
      hitFunc={isTransparent ? (ctx, shape) => {
        const b = Math.max((obj.strokeWidth || 1) / 2 + 6, 8);
        ctx.beginPath(); ctx.rect(0, 0, obj.width, b); ctx.fillStrokeShape(shape);
        ctx.beginPath(); ctx.rect(0, obj.height - b, obj.width, b); ctx.fillStrokeShape(shape);
        ctx.beginPath(); ctx.rect(0, b, b, obj.height - b * 2); ctx.fillStrokeShape(shape);
        ctx.beginPath(); ctx.rect(obj.width - b, b, b, obj.height - b * 2); ctx.fillStrokeShape(shape);
      } : undefined}
    />
  );
}

// ─── EllipseRenderer ─────────────────────────────────────────────────────────

function EllipseRenderer({
  obj, isSelected, tool, onSelect, onDragStart, onDragMove, onTransformEnd, onDragEnd,
}: {
  obj: EllipseObject;
  isSelected: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  return (
    <Ellipse
      id={obj.id}
      x={obj.x} y={obj.y}
      radiusX={obj.radiusX} radiusY={obj.radiusY}
      fill={obj.fill === 'transparent' ? undefined : obj.fill}
      stroke={obj.stroke}
      strokeWidth={obj.strokeWidth}
      opacity={obj.opacity}
      draggable={tool === 'select'}
      onPointerDown={onSelect}
      onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
      onDragMove={onDragMove}
      onClick={onSelect} onTap={onSelect}
      onTransformEnd={onTransformEnd}
      onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
      onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
      onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
    />
  );
}

// ─── LineRenderer ────────────────────────────────────────────────────────────

function LineRenderer({
  obj, tool, onSelect, onDragStart, onDragMove, onDragEnd,
}: {
  obj: LineObject;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  return (
    <Line
      id={obj.id}
      points={[obj.x1, obj.y1, obj.x2, obj.y2]}
      stroke={obj.stroke}
      strokeWidth={obj.strokeWidth}
      opacity={obj.opacity}
      lineCap="round"
      hitStrokeWidth={Math.max(14, obj.strokeWidth + 8)}
      draggable={tool === 'select'}
      onPointerDown={onSelect}
      onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
      onDragMove={onDragMove}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
      onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
      onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
    />
  );
}

// ─── ArrowRenderer ───────────────────────────────────────────────────────────

function ArrowRenderer({
  obj, isSelected, tool, onSelect, onDragStart, onDragMove, onDragEnd,
}: {
  obj: ArrowObject;
  isSelected: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  const { updateObject, stageScale } = useCanvasStore();
  const [bodyDragging, setBodyDragging] = useState(false);

  const cpx = obj.cx ?? (obj.x1 + obj.x2) / 2;
  const cpy = obj.cy ?? (obj.y1 + obj.y2) / 2;
  const endR = 5 / stageScale;
  const midR = 4 / stageScale;
  const handleStroke = 1.5 / stageScale;
  const angle = Math.atan2(obj.y2 - cpy, obj.x2 - cpx);
  const hl = Math.max(10, obj.strokeWidth * 4);
  const hw = Math.max(6, obj.strokeWidth * 2.5);
  // End the stroke at the arrowhead base so it doesn't poke through the tip
  const ex = obj.x2 - hl * Math.cos(angle);
  const ey = obj.y2 - hl * Math.sin(angle);

  const showHandles = isSelected && tool === 'select' && !bodyDragging;

  return (
    <>
      <Shape
        id={obj.id}
        stroke={obj.stroke}
        fill={obj.stroke}
        strokeWidth={obj.strokeWidth}
        hitStrokeWidth={Math.max(20, obj.strokeWidth + 10)}
        lineCap="round"
        opacity={obj.opacity}
        draggable={tool === 'select'}
        onPointerDown={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={(e) => { setBodyDragging(true); setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
        onDragMove={onDragMove}
        onDragEnd={(e) => { setBodyDragging(false); setNodeStageCursor(e.target, ''); onDragEnd(e); }}
        onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
        onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
        sceneFunc={(ctx, shape) => {
          ctx.beginPath();
          ctx.moveTo(obj.x1, obj.y1);
          ctx.quadraticCurveTo(cpx, cpy, ex, ey);
          ctx.strokeShape(shape);

          ctx.save();
          ctx.translate(obj.x2, obj.y2);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-hl, -hw / 2);
          ctx.lineTo(-hl, hw / 2);
          ctx.closePath();
          ctx.fillShape(shape);
          ctx.restore();
        }}
        hitFunc={(ctx, shape) => {
          ctx.beginPath();
          ctx.moveTo(obj.x1, obj.y1);
          ctx.quadraticCurveTo(cpx, cpy, obj.x2, obj.y2);
          ctx.strokeShape(shape);
        }}
      />
      {showHandles && (
        <>
          {/* Start endpoint */}
          <Circle
            x={obj.x1} y={obj.y1}
            radius={endR} fill="#6366f1" stroke="#fff" strokeWidth={handleStroke}
            draggable
            onMouseEnter={(e) => setNodeStageCursor(e.target, 'crosshair')}
            onMouseLeave={(e) => setNodeStageCursor(e.target, '')}
            onPointerDown={(e) => { e.cancelBubble = true; }}
            onDragMove={(e) => { updateObject(obj.id, { x1: e.target.x(), y1: e.target.y() }); }}
          />
          {/* Midpoint / curve control */}
          <Circle
            x={cpx} y={cpy}
            radius={midR} fill="#1e1e2e" stroke="#6366f1" strokeWidth={handleStroke}
            draggable
            onMouseEnter={(e) => setNodeStageCursor(e.target, 'crosshair')}
            onMouseLeave={(e) => setNodeStageCursor(e.target, '')}
            onPointerDown={(e) => { e.cancelBubble = true; }}
            onDragMove={(e) => { updateObject(obj.id, { cx: e.target.x(), cy: e.target.y() }); }}
          />
          {/* End endpoint */}
          <Circle
            x={obj.x2} y={obj.y2}
            radius={endR} fill="#6366f1" stroke="#fff" strokeWidth={handleStroke}
            draggable
            onMouseEnter={(e) => setNodeStageCursor(e.target, 'crosshair')}
            onMouseLeave={(e) => setNodeStageCursor(e.target, '')}
            onPointerDown={(e) => { e.cancelBubble = true; }}
            onDragMove={(e) => { updateObject(obj.id, { x2: e.target.x(), y2: e.target.y() }); }}
          />
        </>
      )}
    </>
  );
}

// ─── TextRenderer ─────────────────────────────────────────────────────────────

function TextRenderer({
  obj, isSelected, tool, onSelect, onDragStart, onDragMove, onDragEnd,
}: {
  obj: TextObject;
  isSelected: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  return (
    <Text
      id={obj.id}
      x={obj.x} y={obj.y}
      text={obj.text}
      fontSize={obj.fontSize}
      fill={obj.color}
      fontFamily={obj.fontFamily}
      draggable={tool === 'select'}
      onPointerDown={onSelect}
      onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
      onDragMove={onDragMove}
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
      onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
      onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
    />
  );
}

// ─── FrameRenderer ───────────────────────────────────────────────────────────
// KEY: image is rendered as a SIBLING of the Group (absolute world coords),
// NOT inside it. This means Konva's Transformer scaling the Group does NOT
// stretch the image. Only the frame border resizes. onDragMove imperatively
// syncs the image position so it follows the frame during a drag.

function FrameRenderer({
  frame, isSelected, isContextFrame, tool, onSelect, onDragStart, onDragMove, onTransformEnd, onDragEnd,
}: {
  frame: FrameObject;
  isSelected: boolean;
  isContextFrame?: boolean;
  tool: string;
  onSelect: (e: ObjectPointerEvent) => void;
  onDragStart: (e: ObjectDragEvent) => void;
  onDragMove: (e: ObjectDragEvent) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>, fr: FrameObject) => void;
  onDragEnd: (e: ObjectDragEvent) => void;
}) {
  const [img] = useImage(frame.imageData ?? '');
  const imgNodeRef = useRef<Konva.Image | null>(null);
  const kind = frame.kind ?? 'image';
  const hasUrl = kind === 'site' && !!frame.url;
  const isPlain = kind === 'plain';
  const isImage = kind === 'image';

  // Image occupies the "old" bounds (before expansion) or the full frame (no expansion)
  const ib = frame.priorBounds ?? { x: frame.x, y: frame.y, width: frame.width, height: frame.height };

  // Defensively sync the image node dimensions after any frame/image update.
  // This guards against Konva state drift on the second outpaint expansion.
  useEffect(() => {
    const node = imgNodeRef.current;
    if (!node || !img) return;
    node.x(ib.x); node.y(ib.y);
    node.width(ib.width); node.height(ib.height);
    node.getLayer()?.batchDraw();
  }, [ib.x, ib.y, ib.width, ib.height, img]);

  const fw = frame.width;
  const fh = frame.height;
  const pb = frame.priorBounds;

  // Outpaint overlay strips — in local Group coords
  const localOldX = pb ? pb.x - frame.x : 0;
  const localOldY = pb ? pb.y - frame.y : 0;

  return (
    <>
      {/* ── Image as sibling (absolute world coords) ───────────────────────── */}
      {img && (
        <KonvaImage
          ref={imgNodeRef}
          id={`${frame.id}-image`}
          x={ib.x} y={ib.y}
          width={ib.width} height={ib.height}
          image={img}
          cornerRadius={2}
          listening={!isImage}
          onPointerDown={!isImage ? onSelect : undefined}
          onClick={!isImage ? onSelect : undefined}
          onTap={!isImage ? onSelect : undefined}
          onMouseEnter={!isImage ? (e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); } : undefined}
          onMouseLeave={!isImage ? (e) => { setNodeStageCursor(e.target, ''); } : undefined}
        />
      )}

      {/* ── Frame border + overlays + label ────────────────────────────────── */}
      <Group
        id={frame.id}
        x={frame.x} y={frame.y}
        draggable={tool === 'select' || isFrameTool(tool)}
        onPointerDown={onSelect}
        onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); onDragStart(e); }}
        onClick={onSelect} onTap={onSelect}
        onTransformEnd={(e) => onTransformEnd(e, frame)}
        onDragMove={(e) => {
          onDragMove(e);
          // Keep image in sync with the frame border during drag (no state update)
          const node = imgNodeRef.current;
          if (!node || !img) return;
          const gx = (e.target as Konva.Group).x();
          const gy = (e.target as Konva.Group).y();
          const dx = gx - frame.x;
          const dy = gy - frame.y;
          node.x(ib.x + dx);
          node.y(ib.y + dy);
          node.getLayer()?.batchDraw();
        }}
        onDragEnd={(e) => { setNodeStageCursor(e.target, ''); onDragEnd(e); }}
        onMouseEnter={(e) => { if (tool === 'select' || isFrameTool(tool)) setNodeStageCursor(e.target, 'move'); }}
        onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
      >
        {/* Background */}
        <Rect
          width={fw} height={fh}
          fill={img || hasUrl ? 'transparent' : (frame.background ?? '#181818')}
          stroke={isSelected ? '#6366f1' : isContextFrame ? '#14b8a6' : '#3a3a3a'}
          strokeWidth={isSelected ? 2 : isContextFrame ? 2 : 1}
          dash={frame.imageData || hasUrl || isPlain ? undefined : [10, 5]}
          cornerRadius={2}
          listening={isImage}
        />

        {/* Title-bar hit zone — non-image frames are only selectable/draggable from the label area */}
        {!isImage && (
          <Rect
            x={0} y={-24}
            width={fw} height={24}
            fill="transparent"
            strokeEnabled={false}
          />
        )}

        {/* Outpaint overlay strips (visible only after expansion) */}
        {pb && (
          <>
            {localOldX > 0 && (
              <Rect x={0} y={localOldY} width={localOldX} height={pb.height}
                fill="rgba(99,102,241,0.18)" stroke="rgba(99,102,241,0.5)" strokeWidth={1} listening={false} />
            )}
            {localOldX + pb.width < fw && (
              <Rect x={localOldX + pb.width} y={localOldY}
                width={fw - (localOldX + pb.width)} height={pb.height}
                fill="rgba(99,102,241,0.18)" stroke="rgba(99,102,241,0.5)" strokeWidth={1} listening={false} />
            )}
            {localOldY > 0 && (
              <Rect x={0} y={0} width={fw} height={localOldY}
                fill="rgba(99,102,241,0.18)" stroke="rgba(99,102,241,0.5)" strokeWidth={1} listening={false} />
            )}
            {localOldY + pb.height < fh && (
              <Rect x={0} y={localOldY + pb.height} width={fw}
                height={fh - (localOldY + pb.height)}
                fill="rgba(99,102,241,0.18)" stroke="rgba(99,102,241,0.5)" strokeWidth={1} listening={false} />
            )}
          </>
        )}

        {frame.generating && (
          <Text
            x={fw / 2 - 60} y={fh / 2 - 10}
            text="Generating…" fontSize={14} fill="#6366f1"
            width={120} align="center" listening={false}
          />
        )}

        {!isImage && <Text x={0} y={-20} text={frame.label} fontSize={11} fill="#666" listening={false} />}
      </Group>
    </>
  );
}

// ─── Text input overlay type ──────────────────────────────────────────────────

interface TextOverlay { x: number; y: number; worldX: number; worldY: number; }
interface RadialMenuPos { x: number; y: number; }

function FrameSiteOverlays({
  frames,
  selectedIds,
  contextFrameIds,
  tool,
  stageX,
  stageY,
  stageScale,
  overlayRefs,
}: {
  frames: FrameObject[];
  selectedIds: string[];
  contextFrameIds: string[];
  tool: string;
  stageX: number;
  stageY: number;
  stageScale: number;
  overlayRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}) {
  const [interactingId, setInteractingId] = useState<string | null>(null);

  // Exit interact mode when the frame is deselected
  useEffect(() => {
    if (interactingId && !selectedIds.includes(interactingId)) {
      setInteractingId(null);
    }
  }, [selectedIds, interactingId]);

  return (
    <>
      {frames.map((frame) => {
        const selected = selectedIds.includes(frame.id);
        const isContext = contextFrameIds.includes(frame.id);
        const isInteracting = interactingId === frame.id;
        const left = stageX + frame.x * stageScale;
        const top = stageY + frame.y * stageScale;

        return (
          <div
            key={frame.id}
            ref={(el) => {
              if (el) overlayRefs.current.set(frame.id, el);
              else overlayRefs.current.delete(frame.id);
            }}
            style={{
              position: 'absolute',
              left,
              top,
              width: frame.width,
              height: frame.height,
              transform: `scale(${stageScale})`,
              transformOrigin: 'top left',
              border: `${(selected || isContext ? 2 : 1) / stageScale}px solid ${selected ? '#6366f1' : isContext ? '#14b8a6' : '#3a3a3a'}`,
              borderRadius: Math.max(2, 2 / stageScale),
              overflow: 'hidden',
              background: '#fff',
              boxSizing: 'border-box',
              // Outer div blocks Konva events when selected; iframe only gets events in interact mode
              pointerEvents: selected && tool === 'select' ? 'auto' : 'none',
              cursor: isInteracting ? 'auto' : 'default',
            }}
            onPointerDown={() => setInteractingId(frame.id)}
            onPointerLeave={() => setInteractingId(null)}
          >
            <iframe
              title={`${frame.label} site`}
              src={frame.url ?? undefined}
              sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
              referrerPolicy="no-referrer"
              style={{
                width: '100%',
                height: '100%',
                border: 0,
                display: 'block',
                background: '#fff',
                // Only receive events when actively interacting; otherwise the outer div
                // absorbs them so the frame can't be accidentally dragged from inside
                pointerEvents: isInteracting ? 'auto' : 'none',
              }}
            />
          </div>
        );
      })}
    </>
  );
}

// ─── Main canvas ─────────────────────────────────────────────────────────────

export default function InfiniteCanvas() {
  const {
    tool, setTool, penMode, keepToolActive,
    objects, addObject, addObjects, updateObject, updateObjects, removeObjects, bringToFront,
    selectedIds, setSelectedIds,
    stageX, stageY, stageScale, setStageTransform,
    brushColor, setBrushColor, brushSize, setBrushSize, brushOpacity, setBrushOpacity,
    pressureSize, setPressureSize, pressureOpacity, setPressureOpacity, pressureMin, setPressureMin,
    fillColor, shapeStrokeColor, shapeStrokeWidth,
    shapeType,
    fontSize, fontColor,
    setOutpaintFrameId,
    incrementFrameCount,
    contextFrameIds, contextPickerActive, toggleContextFrame,
    workingObjectIds,
    setCaptureFrameSnapshot, setCaptureScreenshot,
    undo, redo,
  } = useCanvasStore();

  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: window.innerWidth - TOOLBAR_W, h: window.innerHeight });

  // Register stage capture function for context frame snapshots (non-site frames only)
  useEffect(() => {
    setCaptureFrameSnapshot(async (frame: FrameObject) => {
      const stage = stageRef.current;
      if (!stage) throw new Error('Stage not ready');
      return captureFrameFromStage(stage, frame);
    });
    return () => setCaptureFrameSnapshot(null);
  }, [setCaptureFrameSnapshot]);

  useEffect(() => {
    setCaptureScreenshot(async (target?: ScreenshotTarget, scale = 1) => {
      const stage = stageRef.current;
      if (!stage) throw new Error('Stage not ready');

      if (!target || target.type === 'viewport') {
        return stage.toDataURL({ pixelRatio: scale });
      }

      let bounds: { x: number; y: number; w: number; h: number } | null = null;
      if (target.type === 'bounds') {
        bounds = { x: target.x, y: target.y, w: target.width, h: target.height };
      } else if (target.type === 'object') {
        const object = useCanvasStore.getState().objects.find((obj) => obj.id === target.objectId);
        bounds = object ? expandedBBox(object) : null;
      } else if (target.type === 'selection') {
        const boxes = useCanvasStore.getState().selectedIds
          .map((id) => useCanvasStore.getState().objects.find((obj) => obj.id === id))
          .filter((obj): obj is CanvasObject => !!obj)
          .map(expandedBBox)
          .filter((box): box is { x: number; y: number; w: number; h: number } => !!box);
        if (boxes.length > 0) {
          const minX = Math.min(...boxes.map((box) => box.x));
          const minY = Math.min(...boxes.map((box) => box.y));
          const maxX = Math.max(...boxes.map((box) => box.x + box.w));
          const maxY = Math.max(...boxes.map((box) => box.y + box.h));
          bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
      }

      if (!bounds) throw new Error('Screenshot target not found.');
      return stage.toDataURL({
        x: bounds.x * stageScale + stageX,
        y: bounds.y * stageScale + stageY,
        width: bounds.w * stageScale,
        height: bounds.h * stageScale,
        pixelRatio: scale,
      });
    });
    return () => setCaptureScreenshot(null);
  }, [setCaptureScreenshot, stageScale, stageX, stageY]);

  // ── Drawing state ──────────────────────────────────────────────────────────
  const currentPointsRef = useRef<number[]>([]);
  const currentPressuresRef = useRef<number[]>([]);
  const [livePoints, setLivePoints] = useState<number[]>([]);
  const [livePressures, setLivePressures] = useState<number[]>([]);
  const liveStrokeFrameRef = useRef<number | null>(null);
  const currentStrokeIdRef = useRef('');
  const erasingIdsRef = useRef<Set<string>>(new Set());
  const [erasingIds, setErasingIds] = useState<Set<string>>(new Set());
  const activePointerIdRef = useRef<number | null>(null);
  const capturedPointerElementRef = useRef<Element | null>(null);
  const lastPointerMoveEventRef = useRef<PointerEvent | null>(null);

  // liveShape: React state for visual rendering; ref for use in handlePointerUp
  const [liveShape, setLiveShape] = useState<LiveShape | null>(null);
  const liveShapeRef = useRef<LiveShape | null>(null);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);

  // ── Pan state ──────────────────────────────────────────────────────────────
  const isPanningRef = useRef(false);
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const lastPanPos = useRef<{ x: number; y: number } | null>(null);
  const activeTouchesRef = useRef<Map<number, TouchPoint>>(new Map());
  const capturedTouchElementsRef = useRef<Map<number, Element>>(new Map());
  const lastTouchGestureRef = useRef<TouchGesture | null>(null);
  const touchNavigationFrameRef = useRef<number | null>(null);
  const viewportCommitTimerRef = useRef<number | null>(null);
  const lastRightClickRef = useRef<{ time: number; x: number; y: number } | null>(null);

  // ── Wacom/stylus reliability: window-level up/cancel as safety net ─────────
  // handlePointerUp is recreated on dep changes; keep a ref so the window
  // listener always calls the latest version without re-registering.
  const handlePointerMoveRef = useRef<(event: Konva.KonvaEventObject<PointerEvent> | PointerEvent) => void>(() => {});
  const handlePointerUpRef = useRef<(event?: Konva.KonvaEventObject<PointerEvent> | PointerEvent) => void>(() => {});

  // ── Drag-select (marquee) state ────────────────────────────────────────────
  const isDragSelectRef = useRef(false);
  const dragSelectStartRef = useRef<{ x: number; y: number } | null>(null);
  const [liveSelRect, setLiveSelRect] = useState<SelRect | null>(null);
  const liveSelRectRef = useRef<SelRect | null>(null);
  const multiDragRef = useRef<MultiDragState | null>(null);
  const frameChildDragRef = useRef<FrameChildDragState | null>(null);
  const siteOverlayRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const internalClipboardRef = useRef<CanvasObject[]>([]);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);

  // ── Text overlay ───────────────────────────────────────────────────────────
  const [textOverlay, setTextOverlay] = useState<TextOverlay | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const [radialMenuPos, setRadialMenuPos] = useState<RadialMenuPos | null>(null);

  // ── Prevent click-to-deselect from firing right after shape creation ───────
  const justCreatedRef = useRef(false);
  // Tracks the object id that was alt+duplicated on pointerdown, so the
  // subsequent onClick doesn't re-select the original over the fresh clone.
  const altDupIdRef = useRef<string | null>(null);

  const cancelLiveStrokeFrame = useCallback(() => {
    if (liveStrokeFrameRef.current == null) return;
    window.cancelAnimationFrame(liveStrokeFrameRef.current);
    liveStrokeFrameRef.current = null;
  }, []);

  const scheduleLiveStrokeUpdate = useCallback(() => {
    if (liveStrokeFrameRef.current != null) return;
    liveStrokeFrameRef.current = window.requestAnimationFrame(() => {
      liveStrokeFrameRef.current = null;
      setLivePoints([...currentPointsRef.current]);
      setLivePressures([...currentPressuresRef.current]);
    });
  }, []);

  // ── Container resize ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  // ── Window-level pointerup/cancel — Wacom stylus releases often miss the Stage ──
  // Register once; always call the latest handler via ref.
  useEffect(() => {
    const move = (evt: PointerEvent) => handlePointerMoveRef.current(evt);
    const up = (evt: PointerEvent) => handlePointerUpRef.current(evt);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // ── Attach Transformer to selected nodes ───────────────────────────────────
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;

    if (selectedIds.length === 0 || (tool !== 'select' && !isFrameTool(tool))) {
      tr.nodes([]);
      tr.getLayer()?.batchDraw();
      return;
    }

    const nodes = selectedIds
      .map((id) => {
        const obj = objects.find((o) => o.id === id);
        if (isFrameTool(tool) && obj?.type !== 'frame') return null;
        if (obj?.type === 'arrow') return null; // arrows use point handles, not transformer
        return stage.findOne(`#${id}`);
      })
      .filter(Boolean) as Konva.Node[];
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, tool, objects]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { spaceRef.current = true; setSpaceHeld(true); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault();
        const ids = useCanvasStore.getState().objects.map((o) => o.id);
        if (ids.length > 0) { setTool('select'); setSelectedIds(ids); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === '1') { setTool('select'); return; }
      if (k === '2') { setTool('pen'); return; }
      if (k === '3') { setTool('rect'); return; }
      if (k === '4') { setTool('ellipse'); return; }
      if (k === '5') { setTool('arrow'); return; }
      if (k === '6') { setTool('line'); return; }
      if (k === '7') { setTool('text'); return; }
      if (k === '8') { setTool('imageFrame'); return; }
      if (k === '9') { setTool('frame'); return; }
      if (k === '0') { setTool('eraser'); return; }
      if (e.key === '[' || e.key === ']') {
        const s = useCanvasStore.getState();
        const inc = e.key === ']' ? 1 : -1;
        if (s.tool === 'pen' || s.tool === 'eraser') {
          s.setBrushSize(Math.max(1, Math.min(80, s.brushSize + inc)));
        } else if (s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'arrow' || s.tool === 'line') {
          s.setShapeStrokeWidth(Math.max(0, Math.min(40, s.shapeStrokeWidth + inc)));
        }
        return;
      }
      if ((k === 'delete' || k === 'backspace') && selectedIds.length > 0) { removeObjects(selectedIds); return; }
      if (k === 'escape') {
        setSelectedIds([]);
        setOutpaintFrameId(null);
        setRadialMenuPos(null);
        return;
      }
      // Any letter key → create text box at current cursor position
      if (/^[a-z]$/i.test(e.key)) {
        const worldPos = lastCanvasPointerRef.current;
        if (!worldPos) return;
        const stage = stageRef.current;
        const screenPos = stage ? stage.getAbsoluteTransform().point(worldPos) : worldPos;
        e.preventDefault();
        setTextOverlay({ x: screenPos.x, y: screenPos.y, worldX: worldPos.x, worldY: worldPos.y });
        setTimeout(() => {
          if (textInputRef.current) {
            textInputRef.current.value = e.key;
            textInputRef.current.setSelectionRange(1, 1);
            textInputRef.current.focus();
          }
        }, 0);
      }
    };
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === ' ') { spaceRef.current = false; setSpaceHeld(false); isPanningRef.current = false; lastPanPos.current = null; }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [selectedIds, setTool, removeObjects, setSelectedIds, setOutpaintFrameId, undo, redo]);

  // ── Coordinate helper ──────────────────────────────────────────────────────
  const handleRightButtonUndoGesture = useCallback((evt: PointerEvent | MouseEvent) => {
    evt.preventDefault();
    const now = window.performance.now();
    const last = lastRightClickRef.current;
    if (
      last &&
      now - last.time <= 350 &&
      Math.hypot(evt.clientX - last.x, evt.clientY - last.y) <= 16
    ) {
      undo();
      lastRightClickRef.current = null;
      setRadialMenuPos(null);
    } else {
      lastRightClickRef.current = { time: now, x: evt.clientX, y: evt.clientY };
      if (tool === 'pen' || tool === 'eraser') {
        const rect = containerRef.current?.getBoundingClientRect();
        const lx = rect ? evt.clientX - rect.left : evt.clientX;
        const ly = rect ? evt.clientY - rect.top  : evt.clientY;
        setRadialMenuPos({ x: lx, y: ly });
      }
    }
  }, [tool, undo]);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: sx, y: sy };
    return stage.getAbsoluteTransform().copy().invert().point({ x: sx, y: sy });
  }, []);

  const getPasteAnchor = useCallback(() => {
    if (lastCanvasPointerRef.current) return lastCanvasPointerRef.current;
    return screenToWorld(size.w / 2, size.h / 2);
  }, [screenToWorld, size.h, size.w]);

  const pasteCanvasObjects = useCallback((sourceObjects: CanvasObject[], anchor?: { x: number; y: number }) => {
    const currentObjects = useCanvasStore.getState().objects;
    const clones = duplicateCanvasObjects(sourceObjects, currentObjects, anchor);
    if (clones.length === 0) return false;
    const cloneIdSet = new Set(clones.map((c) => c.id));
    const topLevelIds = clones
      .filter((c) => {
        if (c.type === 'frame') return true;
        const pid = (c as { parentFrameId?: string | null }).parentFrameId;
        return !pid || !cloneIdSet.has(pid);
      })
      .map((c) => c.id);
    addObjects(clones, topLevelIds);
    internalClipboardRef.current = clones;
    setTool('select');
    justCreatedRef.current = true;
    window.requestAnimationFrame(() => { justCreatedRef.current = false; });
    return true;
  }, [addObjects, setTool]);

  const pasteText = useCallback((text: string, anchor: { x: number; y: number }) => {
    const value = text.trim();
    if (!value) return false;

    const id = nanoid();
    addObjects([{
      id,
      type: 'text',
      parentFrameId: findParentFrameIdForBounds(
        { x: anchor.x, y: anchor.y, w: 1, h: 1 },
        useCanvasStore.getState().objects,
      ),
      x: anchor.x,
      y: anchor.y,
      text: value,
      fontSize,
      color: fontColor,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }], [id]);
    setTool('select');
    justCreatedRef.current = true;
    window.requestAnimationFrame(() => { justCreatedRef.current = false; });
    return true;
  }, [addObjects, fontColor, fontSize, setTool]);

  const pasteImages = useCallback(async (
    imageItems: DataTransferItem[],
    anchor: { x: number; y: number },
  ) => {
    const pastedImages = (await Promise.all(imageItems.map(readClipboardImage))).filter(Boolean) as {
      dataUrl: string;
      width: number;
      height: number;
    }[];
    if (pastedImages.length === 0) return false;

    const newObjects: CanvasObject[] = pastedImages.map((image, index) => {
      const scale = Math.min(1, MAX_PASTED_IMAGE_SIZE / Math.max(image.width, image.height));
      const width = Math.max(1, image.width * scale);
      const height = Math.max(1, image.height * scale);
      const x = anchor.x + index * PASTE_OFFSET;
      const y = anchor.y + index * PASTE_OFFSET;
      return {
        id: nanoid(),
        type: 'frame',
        kind: 'image',
        x,
        y,
        width,
        height,
        label: `Image ${incrementFrameCount()}`,
        background: '#181818',
        url: null,
        imageData: image.dataUrl,
        generating: false,
        priorBounds: null,
      };
    });

    addObjects(newObjects, newObjects.map((obj) => obj.id));
    setTool('select');
    justCreatedRef.current = true;
    window.requestAnimationFrame(() => { justCreatedRef.current = false; });
    return true;
  }, [addObjects, incrementFrameCount, setTool]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    const onCopy = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const state = useCanvasStore.getState();
      const selected = new Set(state.selectedIds);
      const selectedObjects = state.objects.filter((obj) =>
        selected.has(obj.id) || (obj.type !== 'frame' && !!obj.parentFrameId && selected.has(obj.parentFrameId))
      );
      if (selectedObjects.length === 0) return;

      internalClipboardRef.current = selectedObjects;
      const payload = JSON.stringify({ objects: selectedObjects });
      e.clipboardData?.setData(CANVAS_CLIPBOARD_MIME, payload);
      e.clipboardData?.setData(
        'text/plain',
        selectedObjects.every((obj) => obj.type === 'text')
          ? selectedObjects.map((obj) => (obj as TextObject).text).join('\n')
          : '',
      );
      e.preventDefault();
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const clipboard = e.clipboardData;
      if (!clipboard) return;

      const anchor = getPasteAnchor();
      const canvasJson = clipboard.getData(CANVAS_CLIPBOARD_MIME);
      if (canvasJson) {
        try {
          const payload = JSON.parse(canvasJson) as { objects?: CanvasObject[] };
          if (payload.objects?.length && pasteCanvasObjects(payload.objects)) {
            e.preventDefault();
            return;
          }
        } catch (_) {}
      }

      const imageItems = Array.from(clipboard.items).filter((item) => item.type.startsWith('image/'));
      if (imageItems.length > 0) {
        e.preventDefault();
        void pasteImages(imageItems, anchor);
        return;
      }

      const text = clipboard.getData('text/plain');
      if (text.trim()) {
        if (pasteText(text, anchor)) e.preventDefault();
        return;
      }

      if (internalClipboardRef.current.length > 0 && pasteCanvasObjects(internalClipboardRef.current)) {
        e.preventDefault();
      }
    };

    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  }, [getPasteAnchor, pasteCanvasObjects, pasteImages, pasteText]);

  const eventToStagePoint = useCallback((evt: PointerEvent): TouchPoint => {
    const stage = stageRef.current;
    const rect = stage?.container().getBoundingClientRect();
    return rect
      ? { x: evt.clientX - rect.left, y: evt.clientY - rect.top }
      : { x: evt.clientX, y: evt.clientY };
  }, []);

  const syncAllOverlays = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ox = stage.x(), oy = stage.y(), sx = stage.scaleX();
    for (const [frameId, el] of siteOverlayRefs.current) {
      const frame = useCanvasStore.getState().objects.find((o) => o.id === frameId) as FrameObject | undefined;
      if (!frame) continue;
      el.style.left = `${ox + frame.x * sx}px`;
      el.style.top = `${oy + frame.y * sx}px`;
      el.style.transform = `scale(${sx})`;
    }
  }, []);

  const commitStageTransform = useCallback((delay = 0) => {
    if (viewportCommitTimerRef.current != null) {
      window.clearTimeout(viewportCommitTimerRef.current);
      viewportCommitTimerRef.current = null;
    }

    const commit = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const pos = stage.position();
      setStageTransform(pos.x, pos.y, stage.scaleX());
    };

    if (delay > 0) {
      viewportCommitTimerRef.current = window.setTimeout(() => {
        viewportCommitTimerRef.current = null;
        commit();
      }, delay);
    } else {
      commit();
    }
  }, [setStageTransform]);

  useEffect(() => () => {
    if (viewportCommitTimerRef.current != null) window.clearTimeout(viewportCommitTimerRef.current);
    if (touchNavigationFrameRef.current != null) window.cancelAnimationFrame(touchNavigationFrameRef.current);
    cancelLiveStrokeFrame();
  }, [cancelLiveStrokeFrame]);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Ctrl/Cmd + scroll → zoom anchored to pointer
      const ptr = stage.getPointerPosition();
      if (!ptr) return;
      const old = stage.scaleX();
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * Math.pow(ZOOM_FACTOR, e.evt.deltaY < 0 ? 1 : -1)));
      const nx = ptr.x - (ptr.x - stage.x()) / old * next;
      const ny = ptr.y - (ptr.y - stage.y()) / old * next;
      stage.scale({ x: next, y: next });
      stage.position({ x: nx, y: ny });
    } else {
      // Plain scroll → pan; Shift swaps axes
      const dx = e.evt.shiftKey ? e.evt.deltaY : e.evt.deltaX;
      const dy = e.evt.shiftKey ? e.evt.deltaX : e.evt.deltaY;
      stage.position({ x: stage.x() - dx, y: stage.y() - dy });
    }

    stage.batchDraw();
    syncAllOverlays();
    commitStageTransform(90);
  }, [commitStageTransform, syncAllOverlays]);

  const getTouchGesture = useCallback((): TouchGesture | null => {
    const touches = Array.from(activeTouchesRef.current.values());
    if (touches.length === 0) return null;
    if (touches.length === 1) return { centerX: touches[0].x, centerY: touches[0].y, distance: null };

    const [a, b] = touches;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return {
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
      distance: Math.sqrt(dx * dx + dy * dy),
    };
  }, []);

  const cancelInProgressCanvasGesture = useCallback(() => {
    isPanningRef.current = false;
    lastPanPos.current = null;
    currentPointsRef.current = [];
    currentPressuresRef.current = [];
    cancelLiveStrokeFrame();
    setLivePoints([]);
    setLivePressures([]);
    shapeStartRef.current = null;
    liveShapeRef.current = null;
    setLiveShape(null);
    isDragSelectRef.current = false;
    dragSelectStartRef.current = null;
    liveSelRectRef.current = null;
    setLiveSelRect(null);
  }, [cancelLiveStrokeFrame]);

  const applyTouchNavigationFrame = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const prev = lastTouchGestureRef.current;
    const nextGesture = getTouchGesture();
    if (!nextGesture) return;

    if (prev) {
      if (prev.distance != null && nextGesture.distance != null && prev.distance > 0) {
        const oldScale = stage.scaleX();
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (nextGesture.distance / prev.distance)));
        const worldX = (prev.centerX - stage.x()) / oldScale;
        const worldY = (prev.centerY - stage.y()) / oldScale;
        const nx = nextGesture.centerX - worldX * nextScale;
        const ny = nextGesture.centerY - worldY * nextScale;
        stage.scale({ x: nextScale, y: nextScale });
        stage.position({ x: nx, y: ny });
        stage.batchDraw();
        syncAllOverlays();
      } else {
        const nx = stage.x() + nextGesture.centerX - prev.centerX;
        const ny = stage.y() + nextGesture.centerY - prev.centerY;
        stage.position({ x: nx, y: ny });
        stage.batchDraw();
        syncAllOverlays();
      }
    }

    lastTouchGestureRef.current = nextGesture;
  }, [getTouchGesture, syncAllOverlays]);

  const handleTouchNavigationMove = useCallback((evt: PointerEvent) => {
    if (!activeTouchesRef.current.has(evt.pointerId)) return;
    evt.preventDefault();

    activeTouchesRef.current.set(evt.pointerId, eventToStagePoint(evt));
    if (touchNavigationFrameRef.current != null) return;
    touchNavigationFrameRef.current = window.requestAnimationFrame(() => {
      touchNavigationFrameRef.current = null;
      applyTouchNavigationFrame();
    });
  }, [applyTouchNavigationFrame, eventToStagePoint]);

  // ── Pointer down ───────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const nev = e.evt;
    if (nev.button === 2) {
      e.cancelBubble = true;
      handleRightButtonUndoGesture(nev);
      return;
    }
    setRadialMenuPos(null);

    const isDrawingTool =
      tool === 'pen' ||
      tool === 'eraser' ||
      tool === 'rect' ||
      tool === 'ellipse' ||
      tool === 'line' ||
      tool === 'arrow' ||
      isFrameTool(tool);

    if (nev.pointerType === 'touch') {
      nev.preventDefault();
      stage.setPointersPositions(nev);
      activeTouchesRef.current.set(nev.pointerId, eventToStagePoint(nev));
      const canvas = stage.container().querySelector('canvas');
      if (canvas) {
        try {
          canvas.setPointerCapture(nev.pointerId);
          capturedTouchElementsRef.current.set(nev.pointerId, canvas);
        } catch (_) {}
      }

      if (penMode || activeTouchesRef.current.size >= 2) {
        activePointerIdRef.current = null;
        capturedPointerElementRef.current = null;
        cancelInProgressCanvasGesture();
        lastTouchGestureRef.current = getTouchGesture();
        return;
      }
    }

    if (penMode && isDrawingTool && !isFrameTool(tool) && nev.pointerType === 'touch') {
      activePointerIdRef.current = nev.pointerId;
      isPanningRef.current = true;
      lastPanPos.current = { x: nev.clientX, y: nev.clientY };
      stage.container().style.cursor = 'grabbing';
      return;
    }

    activePointerIdRef.current = nev.pointerId;

    if (spaceRef.current || tool === 'pan' || nev.button === 1) {
      nev.preventDefault();
      isPanningRef.current = true;
      lastPanPos.current = { x: nev.clientX, y: nev.clientY };
      stage.container().style.cursor = 'grabbing';
    }

    // Force pointer capture so Wacom/stylus move+up events are routed back to
    // this canvas even if the stylus drifts outside or the driver misbehaves.
    const canvas = stage.container().querySelector('canvas');
    if (canvas && nev.pointerId != null) {
      try {
        (canvas as Element).setPointerCapture(nev.pointerId);
        capturedPointerElementRef.current = canvas;
      } catch (_) {}
    }

    if (spaceRef.current || tool === 'pan' || nev.button === 1) return;

    const ptr = stage.getPointerPosition();
    if (!ptr) return;
    const world = screenToWorld(ptr.x, ptr.y);
    lastCanvasPointerRef.current = world;

    if (isFrameTool(tool) && e.target !== stage) return;

    if (tool === 'pen' || tool === 'eraser') {
      currentStrokeIdRef.current = nanoid();
      currentPointsRef.current = [world.x, world.y];
      currentPressuresRef.current = [normalizedPressure(nev)];
      setLivePoints([world.x, world.y]);
      setLivePressures([...currentPressuresRef.current]);
      if (tool === 'eraser') {
        const eraserSz = useCanvasStore.getState().brushSize * 2;
        const newIds = new Set<string>();
        for (const obj of useCanvasStore.getState().objects) {
          if (objectHitsEraser(obj, [world.x, world.y], eraserSz)) newIds.add(obj.id);
        }
        erasingIdsRef.current = newIds;
        setErasingIds(new Set(newIds));
      }
    }

    if (tool === 'rect' || tool === 'ellipse' || isFrameTool(tool)) {
      shapeStartRef.current = world;
      const s: LiveShape = { type: isFrameTool(tool) ? 'rect' : (tool as 'rect' | 'ellipse'), x: world.x, y: world.y, w: 0, h: 0 };
      liveShapeRef.current = s;
      setLiveShape(s);
    }

    if (tool === 'line' || tool === 'arrow') {
      shapeStartRef.current = world;
      const s: LiveShape = { type: tool, x: world.x, y: world.y, w: 0, h: 0 };
      liveShapeRef.current = s;
      setLiveShape(s);
    }

    if (tool === 'text' && nev.pointerType !== 'mouse') {
      setTextOverlay({ x: ptr.x, y: ptr.y, worldX: world.x, worldY: world.y });
      setTimeout(() => textInputRef.current?.focus(), 50);
    }

    if (tool === 'select' && e.target === stageRef.current) {
      isDragSelectRef.current = true;
      dragSelectStartRef.current = world;
      const r = { x: world.x, y: world.y, w: 0, h: 0 };
      liveSelRectRef.current = r;
      setLiveSelRect(r);
    }
  }, [tool, penMode, screenToWorld, cancelInProgressCanvasGesture, getTouchGesture, eventToStagePoint, handleRightButtonUndoGesture]);

  // ── Pointer move ───────────────────────────────────────────────────────────
  const handlePointerMove = useCallback((event: Konva.KonvaEventObject<PointerEvent> | PointerEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const nev = 'evt' in event ? event.evt : event;
    if (lastPointerMoveEventRef.current === nev) return;
    lastPointerMoveEventRef.current = nev;
    if (nev.pointerType === 'touch') {
      stage.setPointersPositions(nev);
      if (activeTouchesRef.current.has(nev.pointerId)) {
        activeTouchesRef.current.set(nev.pointerId, eventToStagePoint(nev));
      }
      if (penMode || activeTouchesRef.current.size >= 2 || activePointerIdRef.current !== nev.pointerId) {
        handleTouchNavigationMove(nev);
        return;
      }
    }
    if (activePointerIdRef.current != null && nev.pointerId !== activePointerIdRef.current) return;
    stage.setPointersPositions(nev);

    // Always track hover position so keyboard shortcuts (e.g. letter → text) land at the cursor.
    const hoverPtr = stage.getPointerPosition();
    if (hoverPtr) lastCanvasPointerRef.current = screenToWorld(hoverPtr.x, hoverPtr.y);

    // Wacom hover: stylus near the tablet surface but not touching — buttons === 0.
    // Skip completely; we only process motion when something is actively pressed.
    const hasActiveGesture =
      isPanningRef.current ||
      isDragSelectRef.current ||
      currentPointsRef.current.length > 0 ||
      shapeStartRef.current != null;
    if (!hasActiveGesture && nev.buttons === 0) return;

    if (isPanningRef.current && lastPanPos.current) {
      // Cancel any Konva node drag that started before the middle-click was
      // recognized as a pan (e.g. draggable selected object under the cursor).
      stage.find((n: Konva.Node) => n.isDragging()).forEach((n) => n.stopDrag());
      const dx = nev.clientX - lastPanPos.current.x;
      const dy = nev.clientY - lastPanPos.current.y;
      stage.x(stage.x() + dx);
      stage.y(stage.y() + dy);
      stage.batchDraw();
      syncAllOverlays();
      lastPanPos.current = { x: nev.clientX, y: nev.clientY };
      return;
    }

    const ptr = stage.getPointerPosition();
    if (!ptr) return;
    const world = screenToWorld(ptr.x, ptr.y);
    lastCanvasPointerRef.current = world;

    if ((tool === 'pen' || tool === 'eraser') && currentPointsRef.current.length > 0) {
      const pts = currentPointsRef.current;
      const prevX = pts[pts.length - 2];
      const prevY = pts[pts.length - 1];
      pts.push(world.x, world.y);
      currentPressuresRef.current.push(normalizedPressure(nev));
      scheduleLiveStrokeUpdate();
      if (tool === 'eraser') {
        const eraserPts = [prevX, prevY, world.x, world.y];
        const eraserSz = useCanvasStore.getState().brushSize * 2;
        const newIds = new Set(erasingIdsRef.current);
        for (const obj of useCanvasStore.getState().objects) {
          if (newIds.has(obj.id)) continue;
          if (objectHitsEraser(obj, eraserPts, eraserSz)) newIds.add(obj.id);
        }
        const prev = erasingIdsRef.current;
        if (newIds.size !== prev.size) {
          erasingIdsRef.current = newIds;
          setErasingIds(new Set(newIds));
        }
      }
    }

    if (shapeStartRef.current && (tool === 'rect' || tool === 'ellipse' || isFrameTool(tool))) {
      const { x: sx, y: sy } = shapeStartRef.current;
      const s: LiveShape = {
        type: isFrameTool(tool) ? 'rect' : (tool as 'rect' | 'ellipse'),
        x: Math.min(sx, world.x), y: Math.min(sy, world.y),
        w: Math.abs(world.x - sx), h: Math.abs(world.y - sy),
      };
      liveShapeRef.current = s;
      setLiveShape(s);
    }

    if (shapeStartRef.current && (tool === 'line' || tool === 'arrow')) {
      const s: LiveShape = { type: tool, x: world.x, y: world.y, w: 0, h: 0 };
      liveShapeRef.current = s;
      setLiveShape(s);
    }

    if (isDragSelectRef.current && dragSelectStartRef.current) {
      const { x: sx, y: sy } = dragSelectStartRef.current;
      const r = {
        x: Math.min(sx, world.x), y: Math.min(sy, world.y),
        w: Math.abs(world.x - sx), h: Math.abs(world.y - sy),
      };
      liveSelRectRef.current = r;
      setLiveSelRect(r);
    }
  }, [tool, penMode, screenToWorld, handleTouchNavigationMove, eventToStagePoint, scheduleLiveStrokeUpdate]);

  // ── Pointer up ─────────────────────────────────────────────────────────────
  const handlePointerUp = useCallback((event?: Konva.KonvaEventObject<PointerEvent> | PointerEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const evt = event && 'evt' in event ? event.evt : event;
    if (evt?.pointerType === 'touch') {
      evt.preventDefault();
      const wasDrawingTouch = !penMode && activePointerIdRef.current === evt.pointerId && activeTouchesRef.current.size <= 1;
      const capturedTouchEl = capturedTouchElementsRef.current.get(evt.pointerId);
      if (capturedTouchEl) {
        try { capturedTouchEl.releasePointerCapture(evt.pointerId); } catch (_) {}
        capturedTouchElementsRef.current.delete(evt.pointerId);
      }
      activeTouchesRef.current.delete(evt.pointerId);
      lastTouchGestureRef.current = getTouchGesture();
      if (activeTouchesRef.current.size === 0) {
        lastTouchGestureRef.current = null;
        commitStageTransform();
      }
      if (!wasDrawingTouch) return;
    }

    if (evt && activePointerIdRef.current != null && evt.pointerId !== activePointerIdRef.current) return;

    const pointerId = activePointerIdRef.current;
    const capturedEl = capturedPointerElementRef.current;
    activePointerIdRef.current = null;
    capturedPointerElementRef.current = null;
    if (capturedEl && pointerId != null) {
      try { capturedEl.releasePointerCapture(pointerId); } catch (_) {}
    }

    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanPos.current = null;
      commitStageTransform();
      stage.container().style.cursor = '';
      return;
    }

    if (isDragSelectRef.current) {
      isDragSelectRef.current = false;
      const rect = liveSelRectRef.current;
      liveSelRectRef.current = null;
      setLiveSelRect(null);
      dragSelectStartRef.current = null;
      if (rect && rect.w > 4 && rect.h > 4) {
        const hit = useCanvasStore.getState().objects
          .filter((obj) => { const bb = getBBox(obj); return bb ? rectsOverlap(rect, bb) : false; })
          .map((obj) => obj.id);
        setSelectedIds(hit);
        justCreatedRef.current = true; // prevent stage onClick from immediately deselecting
        window.requestAnimationFrame(() => { justCreatedRef.current = false; });
      }
      return;
    }

    // ── Commit stroke ──────────────────────────────────────────────────────
    if (tool === 'pen' && currentPointsRef.current.length >= 4) {
      const points = [...currentPointsRef.current];
      const parentFrameId = getParentFrameIdForObject({
        id: currentStrokeIdRef.current,
        type: 'stroke',
        points,
        color: brushColor,
        size: brushSize,
        opacity: brushOpacity,
      }, useCanvasStore.getState().objects);
      addObject({
        id: currentStrokeIdRef.current,
        type: 'stroke',
        parentFrameId,
        points,
        color: brushColor,
        size: brushSize,
        opacity: brushOpacity,
        pressures: [...currentPressuresRef.current],
        pressureSize,
        pressureOpacity,
        pressureMin,
      });
    } else if (tool === 'eraser') {
      if (erasingIdsRef.current.size > 0) {
        removeObjects([...erasingIdsRef.current]);
      }
      erasingIdsRef.current = new Set();
      setErasingIds(new Set());
    }
    currentPointsRef.current = [];
    currentPressuresRef.current = [];
    cancelLiveStrokeFrame();
    setLivePoints([]);
    setLivePressures([]);

    // ── Commit shape / frame ───────────────────────────────────────────────
    const shape = liveShapeRef.current; // always up-to-date (ref, not stale state)
    const start = shapeStartRef.current;

    if (shape && start) {
      const { type, x, y, w, h } = shape;

      const commit = (id: string) => {
        justCreatedRef.current = true; // block the upcoming onClick from deselecting
        window.requestAnimationFrame(() => { justCreatedRef.current = false; });
        setSelectedIds([id]);
      };

      if (isFrameTool(tool) && w > 4 && h > 4) {
        const id = nanoid();
        const kind = frameKindForTool(tool);
        addObject({
          id, type: 'frame',
          kind,
          x, y, width: w, height: h,
          label: `${kind === 'plain' ? 'Frame' : kind === 'image' ? 'Image' : 'Site Preview'} ${incrementFrameCount()}`,
          background: kind === 'site' ? '#ffffff' : '#181818',
          url: null,
          imageData: null, generating: false, priorBounds: null,
        });
        commit(id);

      } else if (type === 'rect' && w > 4 && h > 4) {
        const id = nanoid();
        addObject({
          id, type: 'rect',
          parentFrameId: findParentFrameIdForBounds({ x, y, w, h }, useCanvasStore.getState().objects),
          x, y, width: w, height: h,
          fill: fillColor, stroke: shapeStrokeColor,
          strokeWidth: shapeStrokeWidth, opacity: 1, cornerRadius: 0,
        });
        if (!keepToolActive) setTool('select');
        commit(id);

      } else if (type === 'ellipse' && w > 4 && h > 4) {
        const id = nanoid();
        addObject({
          id, type: 'ellipse',
          parentFrameId: findParentFrameIdForBounds({ x, y, w, h }, useCanvasStore.getState().objects),
          x: x + w / 2, y: y + h / 2,
          radiusX: w / 2, radiusY: h / 2,
          fill: fillColor, stroke: shapeStrokeColor,
          strokeWidth: shapeStrokeWidth, opacity: 1,
        });
        if (!keepToolActive) setTool('select');
        commit(id);

      } else if (type === 'line' || type === 'arrow') {
        const dx = shape.x - start.x, dy = shape.y - start.y;
        if (Math.sqrt(dx * dx + dy * dy) > 4) {
          const id = nanoid();
          addObject({
            id, type,
            parentFrameId: findParentFrameIdForBounds({
              x: Math.min(start.x, shape.x),
              y: Math.min(start.y, shape.y),
              w: Math.abs(shape.x - start.x),
              h: Math.abs(shape.y - start.y),
            }, useCanvasStore.getState().objects),
            x1: start.x, y1: start.y, x2: shape.x, y2: shape.y,
            stroke: shapeStrokeColor, strokeWidth: shapeStrokeWidth, opacity: 1,
          });
          if (!keepToolActive) setTool('select');
          commit(id);
        }
      }
    }

    shapeStartRef.current = null;
    liveShapeRef.current = null;
    setLiveShape(null);
  }, [
    tool, penMode, keepToolActive, brushColor, brushSize, brushOpacity, pressureSize, pressureOpacity, pressureMin,
    fillColor, shapeStrokeColor, shapeStrokeWidth,
    addObject, updateObject, updateObjects, removeObjects, incrementFrameCount,
    setTool, setSelectedIds, getTouchGesture, commitStageTransform, syncAllOverlays, cancelLiveStrokeFrame,
  ]);

  // Keep native window listeners pointing at the latest React/Konva handlers.
  useEffect(() => { handlePointerMoveRef.current = handlePointerMove; }, [handlePointerMove]);
  useEffect(() => { handlePointerUpRef.current = handlePointerUp; }, [handlePointerUp]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const handleObjectSelect = useCallback(
    (id: string, e: ObjectPointerEvent) => {
      const obj = useCanvasStore.getState().objects.find((o) => o.id === id);
      if (tool !== 'select' && !(isFrameTool(tool) && obj?.type === 'frame')) return;
      if ('button' in e.evt && e.evt.button === 2) {
        e.cancelBubble = true;
        handleRightButtonUndoGesture(e.evt);
        return;
      }
      if (isMiddleButtonEvent(e)) {
        e.evt.preventDefault();
        return;
      }
      e.cancelBubble = true;
      justCreatedRef.current = false;

      // Context picker: clicking a non-selected frame toggles its context inclusion.
      // Guard against pointerdown — FrameRenderer binds onSelect to both onPointerDown
      // and onClick, so without this check the toggle fires twice and cancels itself.
      if (contextPickerActive && obj?.type === 'frame' && !selectedIds.includes(id)) {
        if (e.type !== 'pointerdown') toggleContextFrame(id);
        return;
      }

      // imageFrame tool: only image frames are selectable; non-image frames are ignored
      if (tool === 'imageFrame' && obj?.type === 'frame' && (obj as FrameObject).kind !== 'image') {
        return;
      }

      // The onClick fires after every pointerdown+pointerup, even when a drag
      // happened. If we alt+duplicated on pointerdown, the clone is now selected
      // and we must not let the click re-select the original.
      if (e.type === 'click' && altDupIdRef.current === id) {
        altDupIdRef.current = null;
        return;
      }

      if (selectedIds.length > 1 && selectedIds.includes(id)) return;
      setSelectedIds([id]);
      if (obj?.type !== 'frame') bringToFront(id);

      // Alt+duplicate: fire on pointerdown so it's reliable regardless of how
      // Konva routes the subsequent click event.
      if (e.type === 'pointerdown') {
        if (e.evt.altKey) {
          altDupIdRef.current = id;
          const state = useCanvasStore.getState();
          const sourceObjects = state.objects.filter((o) =>
            o.id === id || (o.type !== 'frame' && !!o.parentFrameId && o.parentFrameId === id)
          );
          const clones = duplicateCanvasObjects(sourceObjects, state.objects);
          if (clones.length > 0) {
            const cloneIdSet = new Set(clones.map((c) => c.id));
            const topLevelIds = clones
              .filter((c) => {
                if (c.type === 'frame') return true;
                const pid = (c as { parentFrameId?: string | null }).parentFrameId;
                return !pid || !cloneIdSet.has(pid);
              })
              .map((c) => c.id);
            addObjects(clones, topLevelIds);
            justCreatedRef.current = true;
            window.requestAnimationFrame(() => { justCreatedRef.current = false; });
          }
        } else {
          altDupIdRef.current = null;
        }
      }
    },
    [tool, selectedIds, contextPickerActive, toggleContextFrame, setSelectedIds, bringToFront, handleRightButtonUndoGesture, addObjects],
  );

  const handleObjectDragStart = useCallback(
    (id: string, e: ObjectDragEvent) => {
      const obj = useCanvasStore.getState().objects.find((o) => o.id === id);
      if (tool !== 'select' && !(isFrameTool(tool) && obj?.type === 'frame')) return;
      if (isPanningRef.current || isMiddleButtonEvent(e)) {
        e.target.stopDrag();
        return;
      }
      e.cancelBubble = true;

      if (selectedIds.length <= 1 || !selectedIds.includes(id)) {
        setSelectedIds([id]);
        if (obj?.type !== 'frame') bringToFront(id);
        multiDragRef.current = null;
        const stage = stageRef.current;
        if (obj?.type === 'frame') {
          const childStarts: Record<string, { x: number; y: number }> = {};
          for (const child of useCanvasStore.getState().objects) {
            if (child.type === 'frame' || child.parentFrameId !== id) continue;
            const node = stage?.findOne(`#${child.id}`) as Konva.Node | undefined;
            if (node) childStarts[child.id] = { x: node.x(), y: node.y() };
          }
          frameChildDragRef.current = {
            frameId: id,
            frameStart: { x: e.target.x(), y: e.target.y() },
            childStarts,
          };
        } else {
          frameChildDragRef.current = null;
        }
        return;
      }

      const stage = stageRef.current;
      const nodeStarts: MultiDragState['nodeStarts'] = {};
      const imageStarts: MultiDragState['imageStarts'] = {};
      for (const selectedId of selectedIds) {
        const node = stage?.findOne(`#${selectedId}`) as Konva.Node | undefined;
        if (node) nodeStarts[selectedId] = { x: node.x(), y: node.y() };
        const image = stage?.findOne(`#${selectedId}-image`) as Konva.Node | undefined;
        if (image) imageStarts[selectedId] = { x: image.x(), y: image.y() };
      }

      multiDragRef.current = {
        draggedId: id,
        selectedIds: [...selectedIds],
        targetStart: { x: e.target.x(), y: e.target.y() },
        objects: objects.filter((obj) => selectedIds.includes(obj.id)),
        nodeStarts,
        imageStarts,
      };
    },
    [tool, selectedIds, objects, setSelectedIds, bringToFront],
  );

  const handleObjectDragMove = useCallback(
    (id: string, e: ObjectDragEvent) => {
      const stage = stageRef.current;
      const overlays = siteOverlayRefs.current;

      const moveOverlay = (overlayId: string, wx: number, wy: number) => {
        const el = overlays.get(overlayId);
        if (!el || !stage) return;
        const ox = stage.x(), oy = stage.y(), sx = stage.scaleX();
        el.style.left = `${ox + wx * sx}px`;
        el.style.top = `${oy + wy * sx}px`;
      };

      const frameChildDrag = frameChildDragRef.current;
      if (frameChildDrag?.frameId === id) {
        const dx = e.target.x() - frameChildDrag.frameStart.x;
        const dy = e.target.y() - frameChildDrag.frameStart.y;
        for (const [childId, start] of Object.entries(frameChildDrag.childStarts)) {
          const node = stage?.findOne(`#${childId}`) as Konva.Node | undefined;
          if (!node) continue;
          node.x(start.x + dx);
          node.y(start.y + dy);
        }
        moveOverlay(id, e.target.x(), e.target.y());
        e.target.getLayer()?.batchDraw();
      }

      const drag = multiDragRef.current;
      if (!drag || drag.draggedId !== id) return;

      const dx = e.target.x() - drag.targetStart.x;
      const dy = e.target.y() - drag.targetStart.y;

      moveOverlay(id, e.target.x(), e.target.y());

      for (const selectedId of drag.selectedIds) {
        if (selectedId === id) continue;

        const nodeStart = drag.nodeStarts[selectedId];
        const node = stage?.findOne(`#${selectedId}`) as Konva.Node | undefined;
        if (node && nodeStart) {
          node.x(nodeStart.x + dx);
          node.y(nodeStart.y + dy);
          moveOverlay(selectedId, nodeStart.x + dx, nodeStart.y + dy);
        }

        const imageStart = drag.imageStarts[selectedId];
        const image = stage?.findOne(`#${selectedId}-image`) as Konva.Node | undefined;
        if (image && imageStart) {
          image.x(imageStart.x + dx);
          image.y(imageStart.y + dy);
        }
      }

      e.target.getLayer()?.batchDraw();
    },
    [],
  );

  const handleObjectDragEnd = useCallback(
    (id: string, e: ObjectDragEvent): boolean => {
      const drag = multiDragRef.current;
      if (!drag || drag.draggedId !== id) return false;

      const dx = e.target.x() - drag.targetStart.x;
      const dy = e.target.y() - drag.targetStart.y;
      const stage = stageRef.current;

      for (const selectedId of drag.selectedIds) {
        const nodeStart = drag.nodeStarts[selectedId];
        const node = stage?.findOne(`#${selectedId}`) as Konva.Node | undefined;
        if (node && nodeStart) {
          node.x(nodeStart.x);
          node.y(nodeStart.y);
        }

        const imageStart = drag.imageStarts[selectedId];
        const image = stage?.findOne(`#${selectedId}-image`) as Konva.Node | undefined;
        if (image && imageStart) {
          image.x(imageStart.x);
          image.y(imageStart.y);
        }
      }

      const updatesById = Object.fromEntries(
        drag.objects.map((obj) => [obj.id, shiftCanvasObject(obj, dx, dy)]),
      );
      updateObjects(updatesById);
      multiDragRef.current = null;
      e.target.getLayer()?.batchDraw();
      return true;
    },
    [updateObjects],
  );

  const handleStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Ignore the click that immediately follows shape creation
      if (justCreatedRef.current) { justCreatedRef.current = false; return; }

      // Mouse text placement: open overlay on click (after full pointer sequence) to
      // avoid the newly-focused input being blurred by the subsequent mousedown event.
      if (tool === 'text' && e.evt.button === 0) {
        const stage = stageRef.current;
        if (!stage) return;
        const ptr = stage.getPointerPosition();
        if (!ptr) return;
        const world = screenToWorld(ptr.x, ptr.y);
        setTextOverlay({ x: ptr.x, y: ptr.y, worldX: world.x, worldY: world.y });
        setTimeout(() => textInputRef.current?.focus(), 0);
        return;
      }

      if (tool !== 'select' && !isFrameTool(tool)) return;
      if (e.target === stageRef.current && e.evt.button === 0) { setSelectedIds([]); setOutpaintFrameId(null); }
    },
    [tool, screenToWorld, setSelectedIds, setOutpaintFrameId],
  );

  // ── Transform end handlers ─────────────────────────────────────────────────
  const handleShapeTransformEnd = useCallback(
    (e: Konva.KonvaEventObject<Event>, obj: RectObject | EllipseObject | StrokeObject) => {
      const node = e.target as Konva.Node;
      const sx = node.scaleX(), sy = node.scaleY();
      node.scaleX(1); node.scaleY(1);
      const dx = node.x(), dy = node.y();
      node.x(0); node.y(0);

      if (obj.type === 'rect') {
        updateObject(obj.id, { x: dx, y: dy, width: obj.width * sx, height: obj.height * sy });
      } else if (obj.type === 'ellipse') {
        updateObject(obj.id, { x: dx + obj.x, y: dy + obj.y, radiusX: obj.radiusX * sx, radiusY: obj.radiusY * sy });
      } else if (obj.type === 'stroke') {
        const bake = (pts: number[]) =>
          pts.map((v, i) => i % 2 === 0 ? dx + v * sx : dy + v * sy);
        updateObject(obj.id, { points: bake(obj.points) });
      }
    },
    [updateObject],
  );

  const handleFrameTransformEnd = useCallback(
    (e: Konva.KonvaEventObject<Event>, frame: FrameObject) => {
      const node = e.target as Konva.Group;
      const sx = node.scaleX(), sy = node.scaleY();
      node.scaleX(1); node.scaleY(1);
      const newX = node.x(), newY = node.y();
      const newW = frame.width * sx, newH = frame.height * sy;
      const expanded = (newW > frame.width + 5 || newH > frame.height + 5) && !!frame.imageData;
      updateObject(frame.id, {
        x: newX, y: newY, width: newW, height: newH,
        // Preserve existing priorBounds when already set — it points to the actual image bounds.
        // Only record new priorBounds on the first expansion of the current image.
        priorBounds: expanded
          ? (frame.priorBounds ?? { x: frame.x, y: frame.y, width: frame.width, height: frame.height })
          : frame.priorBounds,
      });
      if (expanded) setOutpaintFrameId(frame.id);
    },
    [updateObject, setOutpaintFrameId],
  );

  // ── Text submit ────────────────────────────────────────────────────────────
  const submitText = useCallback((value: string) => {
    let newId: string | null = null;
    if (value.trim() && textOverlay) {
      newId = nanoid();
      addObject({
        id: newId, type: 'text',
        parentFrameId: findParentFrameIdForBounds(
          { x: textOverlay.worldX, y: textOverlay.worldY, w: 1, h: 1 },
          useCanvasStore.getState().objects,
        ),
        x: textOverlay.worldX, y: textOverlay.worldY,
        text: value.trim(), fontSize, color: fontColor,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      });
    }
    setTextOverlay(null);
    if (!keepToolActive) {
      setTool('select');
      if (newId) {
        justCreatedRef.current = true;
        window.requestAnimationFrame(() => { justCreatedRef.current = false; });
        setSelectedIds([newId]);
      }
    }
  }, [textOverlay, fontSize, fontColor, addObject, keepToolActive, setTool, setSelectedIds]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const contextFrameIdSet = useMemo(() => new Set(contextFrameIds), [contextFrameIds]);
  const workingObjectIdSet = useMemo(() => new Set(workingObjectIds), [workingObjectIds]);
  const viewportBounds = useMemo(
    () => getViewportWorldBounds(stageX, stageY, stageScale, size.w, size.h),
    [stageX, stageY, stageScale, size.w, size.h],
  );
  const sortedVisibleObjects = useMemo(() => {
    return objects
      .filter((obj) => {
        if (selectedIdSet.has(obj.id) || contextFrameIdSet.has(obj.id)) return true;
        const box = expandedBBox(obj);
        return box ? rectsOverlap(viewportBounds, box) : false;
      })
      .sort((a, b) => {
        if (a.type === 'frame' && b.type !== 'frame') return -1;
        if (a.type !== 'frame' && b.type === 'frame') return 1;
        return 0;
      });
  }, [objects, selectedIdSet, contextFrameIdSet, viewportBounds]);
  const visibleSiteFrames = useMemo(() => (
    sortedVisibleObjects.filter((obj): obj is FrameObject =>
      obj.type === 'frame' && (obj.kind === 'site' || (!obj.kind && !!obj.url)) && !!obj.url
    )
  ), [sortedVisibleObjects]);
  const workingBoxes = useMemo(() => (
    objects
      .filter((obj) => workingObjectIdSet.has(obj.id))
      .map((obj) => ({ id: obj.id, box: expandedBBox(obj) }))
      .filter((item): item is { id: string; box: { x: number; y: number; w: number; h: number } } => !!item.box)
  ), [objects, workingObjectIdSet]);

  const cursor = spaceHeld || tool === 'pan' ? 'grab'
    : tool === 'pen' || tool === 'eraser' || tool === 'rect' || tool === 'ellipse'
      || tool === 'line' || tool === 'arrow' || isFrameTool(tool) ? 'crosshair'
    : tool === 'text' ? 'text'
    : 'default';

  // Pan to LLM focus target when the bridge signals a new change center.
  const pendingFocusCenter = useCanvasStore((s) => s.pendingFocusCenter);
  const setPendingFocusCenter = useCanvasStore((s) => s.setPendingFocusCenter);
  useEffect(() => {
    if (!pendingFocusCenter) return;
    const newX = size.w / 2 - pendingFocusCenter.x * stageScale;
    const newY = size.h / 2 - pendingFocusCenter.y * stageScale;
    setStageTransform(newX, newY, stageScale);
    setPendingFocusCenter(null);
  }, [pendingFocusCenter, setPendingFocusCenter, size, stageScale, setStageTransform]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        cursor,
        touchAction: 'none',
        userSelect: 'none',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Stage
        ref={stageRef}
        width={size.w} height={size.h}
        x={stageX} y={stageY}
        scaleX={stageScale} scaleY={stageScale}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleStageClick}
        style={{ background: 'var(--theme-bg)', touchAction: 'none' }}
      >
        {/* All objects */}
        <Layer listening={tool === 'select' || isFrameTool(tool)}>
          {sortedVisibleObjects.map((obj) => {
            const isSel = selectedIdSet.has(obj.id);
            const erasingOpacity = tool === 'eraser' && erasingIds.has(obj.id) ? 0.2 : 1;

            if (obj.type === 'stroke')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <StrokeRenderer
                  obj={obj} isSelected={isSel} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const node = e.target as Konva.Group;
                    const dx = node.x(), dy = node.y();
                    node.x(0); node.y(0);
                    const shift = (pts: number[]) =>
                      pts.map((v, i) => i % 2 === 0 ? v + dx : v + dy);
                    const moved = { ...obj, points: shift(obj.points) };
                    updateObject(obj.id, {
                      points: moved.points,
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                  onTransformEnd={(e) => handleShapeTransformEnd(e, obj)}
                />
                </Group>
              );

            if (obj.type === 'rect')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <RectRenderer
                  obj={obj} isSelected={isSel} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onTransformEnd={(e) => handleShapeTransformEnd(e, obj)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const moved = { ...obj, x: e.target.x(), y: e.target.y() };
                    updateObject(obj.id, {
                      x: moved.x,
                      y: moved.y,
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                />
                </Group>
              );

            if (obj.type === 'ellipse')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <EllipseRenderer
                  obj={obj} isSelected={isSel} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onTransformEnd={(e) => handleShapeTransformEnd(e, obj)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const moved = { ...obj, x: e.target.x(), y: e.target.y() };
                    updateObject(obj.id, {
                      x: moved.x,
                      y: moved.y,
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                />
                </Group>
              );

            if (obj.type === 'line')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <LineRenderer
                  obj={obj} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const node = e.target as Konva.Line;
                    const dx = node.x(), dy = node.y();
                    node.x(0); node.y(0);
                    const moved = {
                      ...obj,
                      x1: obj.x1 + dx, y1: obj.y1 + dy,
                      x2: obj.x2 + dx, y2: obj.y2 + dy,
                    };
                    updateObject(obj.id, {
                      x1: moved.x1, y1: moved.y1,
                      x2: moved.x2, y2: moved.y2,
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                />
                </Group>
              );

            if (obj.type === 'arrow')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <ArrowRenderer
                  obj={obj} isSelected={isSel} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const node = e.target as Konva.Shape;
                    const dx = node.x(), dy = node.y();
                    node.x(0); node.y(0);
                    const moved = {
                      ...obj,
                      x1: obj.x1 + dx, y1: obj.y1 + dy,
                      x2: obj.x2 + dx, y2: obj.y2 + dy,
                    };
                    updateObject(obj.id, {
                      x1: moved.x1, y1: moved.y1,
                      x2: moved.x2, y2: moved.y2,
                      ...(obj.cx != null ? { cx: obj.cx + dx, cy: obj.cy! + dy } : {}),
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                />
                </Group>
              );

            if (obj.type === 'text')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                <TextRenderer
                  obj={obj} isSelected={isSel} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const moved = { ...obj, x: e.target.x(), y: e.target.y() };
                    updateObject(obj.id, {
                      x: moved.x,
                      y: moved.y,
                      parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                    });
                  }}
                />
                </Group>
              );

            if (obj.type === 'comment')
              return (
                <Group key={obj.id} opacity={erasingOpacity}>
                  <Text
                    id={obj.id}
                    x={obj.x}
                    y={obj.y}
                    text={obj.text}
                    fill={obj.resolved ? '#94a3b8' : '#facc15'}
                    fontSize={14}
                    fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
                    padding={6}
                    draggable={tool === 'select'}
                    onPointerDown={(e) => handleObjectSelect(obj.id, e)}
                    onClick={(e) => handleObjectSelect(obj.id, e)}
                    onTap={(e) => handleObjectSelect(obj.id, e as ObjectPointerEvent)}
                    onDragStart={(e) => { setNodeStageCursor(e.target, 'grabbing'); handleObjectDragStart(obj.id, e); }}
                    onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                    onDragEnd={(e) => {
                      if (handleObjectDragEnd(obj.id, e)) return;
                      const moved = { ...obj, x: e.target.x(), y: e.target.y() };
                      updateObject(obj.id, {
                        x: moved.x,
                        y: moved.y,
                        parentFrameId: getParentFrameIdForObject(moved, useCanvasStore.getState().objects),
                      });
                    }}
                    onMouseEnter={(e) => { if (tool === 'select') setNodeStageCursor(e.target, 'move'); }}
                    onMouseLeave={(e) => { setNodeStageCursor(e.target, ''); }}
                  />
                </Group>
              );

            if (obj.type === 'frame')
              return (
                <FrameRenderer
                  key={obj.id} frame={obj} isSelected={isSel} isContextFrame={contextFrameIdSet.has(obj.id)} tool={tool}
                  onSelect={(e) => handleObjectSelect(obj.id, e)}
                  onDragStart={(e) => handleObjectDragStart(obj.id, e)}
                  onDragMove={(e) => handleObjectDragMove(obj.id, e)}
                  onTransformEnd={handleFrameTransformEnd}
                  onDragEnd={(e) => {
                    if (handleObjectDragEnd(obj.id, e)) return;
                    const frameChildDrag = frameChildDragRef.current;
                    if (frameChildDrag?.frameId === obj.id) {
                      for (const [childId, start] of Object.entries(frameChildDrag.childStarts)) {
                        const node = stageRef.current?.findOne(`#${childId}`) as Konva.Node | undefined;
                        if (!node) continue;
                        node.x(start.x);
                        node.y(start.y);
                      }
                    }
                    frameChildDragRef.current = null;
                    const newX = e.target.x(), newY = e.target.y();
                    const dx = newX - obj.x, dy = newY - obj.y;
                    const childUpdates = Object.fromEntries(
                      useCanvasStore.getState().objects
                        .filter((child) => child.type !== 'frame' && child.parentFrameId === obj.id)
                        .map((child) => [child.id, shiftCanvasObject(child, dx, dy)]),
                    );
                    updateObjects({
                      ...childUpdates,
                      [obj.id]: {
                        x: newX, y: newY,
                        priorBounds: obj.priorBounds ? {
                          x: obj.priorBounds.x + dx,
                          y: obj.priorBounds.y + dy,
                          width: obj.priorBounds.width,
                          height: obj.priorBounds.height,
                        } : null,
                      },
                    });
                  }}
                />
              );

            return null;
          })}

          <Transformer
            ref={trRef}
            keepRatio={false}
            rotateEnabled={false}
            borderStroke="#6366f1"
            borderStrokeWidth={1.5}
            anchorFill="#fff"
            anchorStroke="#6366f1"
            anchorSize={8}
            anchorCornerRadius={2}
          />
        </Layer>

        {/* Live drawing */}
        <Layer listening={false}>
          {workingBoxes.map(({ id, box }) => (
            <Group key={`working-${id}`}>
              <Rect
                x={box.x - 6}
                y={box.y - 6}
                width={box.w + 12}
                height={box.h + 12}
                stroke="#14b8a6"
                strokeWidth={2 / stageScale}
                dash={[8 / stageScale, 5 / stageScale]}
                cornerRadius={6 / stageScale}
                listening={false}
              />
              <Text
                x={box.x - 6}
                y={box.y - 28 / stageScale}
                text="agent"
                fill="#14b8a6"
                fontSize={12 / stageScale}
                fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
                listening={false}
              />
            </Group>
          ))}
          {livePoints.length >= 4 && (
            <PressureStrokeLines
              points={livePoints}
              pressures={tool === 'pen' ? livePressures : undefined}
              color={tool === 'eraser' ? '#aaaaaa' : brushColor}
              size={tool === 'eraser' ? brushSize * 2 : brushSize}
              opacity={brushOpacity}
              pressureSize={tool === 'pen' && pressureSize}
              pressureOpacity={tool === 'pen' && pressureOpacity}
              pressureMin={pressureMin}
            />
          )}
          {liveShape && liveShape.type === 'rect' && liveShape.w > 0 && (
            <Rect
              x={liveShape.x} y={liveShape.y} width={liveShape.w} height={liveShape.h}
              fill={isFrameTool(tool) ? 'transparent' : (fillColor === 'transparent' ? undefined : fillColor)}
              stroke={isFrameTool(tool) ? '#6366f1' : shapeStrokeColor}
              strokeWidth={isFrameTool(tool) ? 1.5 : shapeStrokeWidth}
              dash={isFrameTool(tool) ? [8, 4] : undefined}
              opacity={0.7}
            />
          )}
          {liveShape && liveShape.type === 'ellipse' && liveShape.w > 0 && (
            <Ellipse
              x={liveShape.x + liveShape.w / 2} y={liveShape.y + liveShape.h / 2}
              radiusX={liveShape.w / 2} radiusY={liveShape.h / 2}
              fill={fillColor === 'transparent' ? undefined : fillColor}
              stroke={shapeStrokeColor} strokeWidth={shapeStrokeWidth}
              opacity={0.7}
            />
          )}
          {liveShape && liveShape.type === 'line' && shapeStartRef.current && (
            <Line
              points={[shapeStartRef.current.x, shapeStartRef.current.y, liveShape.x, liveShape.y]}
              stroke={shapeStrokeColor} strokeWidth={shapeStrokeWidth}
              lineCap="round" opacity={0.7}
            />
          )}
          {liveShape && liveShape.type === 'arrow' && shapeStartRef.current && (() => {
            const x1 = shapeStartRef.current!.x, y1 = shapeStartRef.current!.y;
            const x2 = liveShape.x, y2 = liveShape.y;
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const hl = Math.max(10, shapeStrokeWidth * 4);
            const hw = Math.max(6, shapeStrokeWidth * 2.5);
            return (
              <Shape
                stroke={shapeStrokeColor} fill={shapeStrokeColor}
                strokeWidth={shapeStrokeWidth} lineCap="round" opacity={0.7}
                sceneFunc={(ctx, shape) => {
                  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                  ctx.strokeShape(shape);
                  ctx.save();
                  ctx.translate(x2, y2); ctx.rotate(angle);
                  ctx.beginPath();
                  ctx.moveTo(0, 0); ctx.lineTo(-hl, -hw / 2); ctx.lineTo(-hl, hw / 2);
                  ctx.closePath(); ctx.fillShape(shape);
                  ctx.restore();
                }}
                listening={false}
              />
            );
          })()}
          {liveSelRect && liveSelRect.w > 0 && (
            <Rect
              x={liveSelRect.x} y={liveSelRect.y}
              width={liveSelRect.w} height={liveSelRect.h}
              fill="rgba(99,102,241,0.08)"
              stroke="#6366f1"
              strokeWidth={1 / stageScale}
              dash={[4 / stageScale, 3 / stageScale]}
            />
          )}
        </Layer>
      </Stage>

      <FrameSiteOverlays
        frames={visibleSiteFrames}
        selectedIds={selectedIds}
        contextFrameIds={contextFrameIds}
        tool={tool}
        stageX={stageX}
        stageY={stageY}
        stageScale={stageScale}
        overlayRefs={siteOverlayRefs}
      />

      {radialMenuPos && (
        <RadialMenu
          cx={radialMenuPos.x}
          cy={radialMenuPos.y}
          tool={tool}
          brushColor={brushColor}
          brushSize={brushSize}
          brushOpacity={brushOpacity}
          setBrushColor={setBrushColor}
          setBrushSize={setBrushSize}
          setBrushOpacity={setBrushOpacity}
          onDismiss={() => setRadialMenuPos(null)}
        />
      )}

      {/* Text input overlay */}
      {textOverlay && (
        <textarea
          ref={textInputRef}
          rows={1}
          placeholder="Type here..."
          style={{
            position: 'absolute',
            left: textOverlay.x, top: textOverlay.y,
            background: 'rgba(17,17,17,0.92)',
            border: '1.5px solid #6366f1',
            borderRadius: 6,
            outline: 'none',
            color: fontColor,
            fontSize: `${fontSize * stageScale}px`,
            minWidth: 180,
            padding: '4px 8px',
            caretColor: '#6366f1',
            fontFamily: 'inherit',
            boxShadow: '0 2px 16px rgba(0,0,0,0.5)',
            resize: 'none',
            overflow: 'hidden',
            lineHeight: '1.4',
          }}
          autoFocus
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              submitText((e.target as HTMLTextAreaElement).value);
            }
            // Enter inserts newline (default textarea behavior)
          }}
          onBlur={(e) => submitText(e.target.value)}
        />
      )}
    </div>
  );
}
