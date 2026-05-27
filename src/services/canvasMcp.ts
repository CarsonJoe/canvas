import { nanoid } from 'nanoid';
import { ScreenshotTarget, useCanvasStore } from '../store/useCanvasStore';
import {
  CanvasObject,
  CanvasPatch,
} from '../types/canvas';

type Bounds = { x: number; y: number; width: number; height: number };

function objectBounds(obj: CanvasObject): Bounds | null {
  if (obj.type === 'rect') return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
  if (obj.type === 'ellipse') return { x: obj.x - obj.radiusX, y: obj.y - obj.radiusY, width: obj.radiusX * 2, height: obj.radiusY * 2 };
  if (obj.type === 'frame') return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
  if (obj.type === 'line' || obj.type === 'arrow') {
    return {
      x: Math.min(obj.x1, obj.x2),
      y: Math.min(obj.y1, obj.y2),
      width: Math.abs(obj.x2 - obj.x1),
      height: Math.abs(obj.y2 - obj.y1),
    };
  }
  if (obj.type === 'text' || obj.type === 'comment') {
    const fontSize = obj.type === 'text' ? obj.fontSize : 14;
    return { x: obj.x, y: obj.y - fontSize, width: obj.text.length * fontSize * 0.6, height: fontSize * 1.2 };
  }
  if (obj.type === 'stroke') {
    if (obj.points.length < 2) return null;
    const xs = obj.points.filter((_, index) => index % 2 === 0);
    const ys = obj.points.filter((_, index) => index % 2 === 1);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return null;
}

function shiftObject(obj: CanvasObject, dx: number, dy: number, id = obj.id): CanvasObject {
  if (obj.type === 'rect') return { ...obj, id, x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'ellipse') return { ...obj, id, x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'text' || obj.type === 'comment') return { ...obj, id, x: obj.x + dx, y: obj.y + dy };
  if (obj.type === 'line') return { ...obj, id, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
  if (obj.type === 'arrow') {
    return {
      ...obj,
      id,
      x1: obj.x1 + dx,
      y1: obj.y1 + dy,
      x2: obj.x2 + dx,
      y2: obj.y2 + dy,
      ...(obj.cx != null ? { cx: obj.cx + dx, cy: (obj.cy ?? obj.y1) + dy } : {}),
    };
  }
  if (obj.type === 'stroke') return { ...obj, id, points: obj.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) };
  return {
    ...obj,
    id,
    x: obj.x + dx,
    y: obj.y + dy,
    priorBounds: obj.priorBounds
      ? { ...obj.priorBounds, x: obj.priorBounds.x + dx, y: obj.priorBounds.y + dy }
      : null,
  };
}

function objectParentId(obj: CanvasObject): string | null {
  if ('parentId' in obj && typeof obj.parentId === 'string') return obj.parentId;
  if ('parentFrameId' in obj && typeof obj.parentFrameId === 'string') return obj.parentFrameId;
  return null;
}

function normalizeCreatedObject(object: CanvasObject): CanvasObject {
  if (object.id) return object;
  return { ...object, id: nanoid() } as CanvasObject;
}

export const canvasMcpTools = {
  get_document() {
    return useCanvasStore.getState().exportDocument();
  },

  get_object_info(objectId: string) {
    const object = useCanvasStore.getState().objects.find((obj) => obj.id === objectId);
    return object ? { object, bounds: objectBounds(object) } : null;
  },

  get_children(objectId: string) {
    return useCanvasStore.getState().objects.filter((obj) => objectParentId(obj) === objectId);
  },

  get_tree_summary(objectId?: string, depth = 2) {
    const state = useCanvasStore.getState();
    const roots = objectId
      ? state.objects.filter((obj) => obj.id === objectId)
      : state.objects.filter((obj) => !objectParentId(obj));
    const summarize = (obj: CanvasObject, level: number): unknown => ({
      id: obj.id,
      type: obj.type,
      label: obj.type === 'frame' ? obj.label : obj.type === 'text' || obj.type === 'comment' ? obj.text.slice(0, 80) : undefined,
      bounds: objectBounds(obj),
      children: level < depth
        ? state.objects.filter((child) => objectParentId(child) === obj.id).map((child) => summarize(child, level + 1))
        : undefined,
    });
    return roots.map((obj) => summarize(obj, 0));
  },

  async get_screenshot(target?: ScreenshotTarget, scale?: number) {
    const capture = useCanvasStore.getState().captureScreenshot;
    if (!capture) throw new Error('Screenshot capture is not ready.');
    return { imageData: await capture(target, scale) };
  },

  create_objects(objects: CanvasObject[], select = true) {
    const normalized = objects.map(normalizeCreatedObject);
    useCanvasStore.getState().applyPatch({ op: 'create', objects: normalized, select });
    return { createdIds: normalized.map((obj) => obj.id), objects: normalized };
  },

  update_objects(updates: Array<{ id: string; changes: Partial<CanvasObject> }>) {
    useCanvasStore.getState().applyPatch(updates.map((item) => ({ op: 'update', id: item.id, changes: item.changes })));
    return { updatedIds: updates.map((item) => item.id) };
  },

  duplicate_objects(ids: string[], offset = { x: 24, y: 24 }) {
    const state = useCanvasStore.getState();
    const clones = state.objects
      .filter((obj) => ids.includes(obj.id))
      .map((obj) => shiftObject(obj, offset.x, offset.y, nanoid()));
    state.applyPatch({ op: 'create', objects: clones, select: true });
    return { createdIds: clones.map((obj) => obj.id) };
  },

  delete_objects(ids: string[]) {
    useCanvasStore.getState().applyPatch({ op: 'delete', ids });
    return { deletedIds: ids };
  },

  apply_patch(patch: CanvasPatch | CanvasPatch[]) {
    useCanvasStore.getState().applyPatch(patch);
    return { ok: true };
  },
};

export type CanvasMcpTools = typeof canvasMcpTools;
