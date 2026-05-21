export type ToolType =
  | 'select'
  | 'pan'
  | 'pen'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'frame'
  | 'imageFrame'
  | 'siteFrame';

export interface StrokeObject {
  id: string;
  type: 'stroke';
  parentFrameId?: string | null;
  // flat array [x0,y0,x1,y1,...] in world coordinates
  points: number[];
  color: string;
  size: number;
  opacity: number;
  // Per point stylus pressure samples, normalized 0..1.
  pressures?: number[];
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureMin?: number;
}

export interface RectObject {
  id: string;
  type: 'rect';
  parentFrameId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  cornerRadius: number;
}

export interface EllipseObject {
  id: string;
  type: 'ellipse';
  parentFrameId?: string | null;
  // center coordinates
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface LineObject {
  id: string;
  type: 'line';
  parentFrameId?: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface ArrowObject {
  id: string;
  type: 'arrow';
  parentFrameId?: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx?: number | null;
  cy?: number | null;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface TextObject {
  id: string;
  type: 'text';
  parentFrameId?: string | null;
  parentId?: string | null;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  fontFamily: string;
}

export interface CommentObject {
  id: string;
  type: 'comment';
  parentFrameId?: string | null;
  parentId?: string | null;
  x: number;
  y: number;
  text: string;
  resolved: boolean;
  createdAt: string;
}

export interface FrameObject {
  id: string;
  type: 'frame';
  kind: 'plain' | 'image' | 'site';
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  background: string;
  url: string | null;
  imageData: string | null;
  generating: boolean;
  // Bounds before the most recent expansion (for outpainting)
  priorBounds: { x: number; y: number; width: number; height: number } | null;
}

export type CanvasObject =
  | StrokeObject
  | RectObject
  | EllipseObject
  | LineObject
  | ArrowObject
  | TextObject
  | CommentObject
  | FrameObject;

export interface ProjectLink {
  id: string;
  kind: 'local-project';
  name: string;
  path?: string;
  repoRoot?: string;
  previewUrl?: string;
  createdAt: string;
}

export interface CanvasDocument {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  objects: CanvasObject[];
  selectedIds: string[];
  viewport: {
    x: number;
    y: number;
    scale: number;
  };
  links?: ProjectLink[];
}

export type CanvasPatch =
  | { op: 'create'; objects: CanvasObject[]; select?: boolean }
  | { op: 'update'; id: string; changes: Partial<CanvasObject> }
  | { op: 'delete'; ids: string[] }
  | { op: 'select'; ids: string[] }
  | { op: 'viewport'; x: number; y: number; scale: number };
