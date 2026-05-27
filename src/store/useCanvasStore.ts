import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  CanvasDocument,
  CanvasObject,
  CanvasPatch,
  FrameObject,
  ToolType,
} from '../types/canvas';

// IndexedDB storage adapter — no 5MB quota limit like localStorage
let _dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('canvas-app-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
  }
  return _dbPromise;
}

const idbStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const db = await getDb();
      const result = await new Promise<string | null>((resolve) => {
        const req = db.transaction('kv').objectStore('kv').get(name);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
      if (result !== null) return result;
      // One-time migration from localStorage
      const legacy = localStorage.getItem(name);
      if (legacy !== null) {
        await idbStorage.setItem(name, legacy);
        localStorage.removeItem(name);
        return legacy;
      }
      return null;
    } catch {
      return localStorage.getItem(name);
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const db = await getDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      try { localStorage.setItem(name, value); } catch { /* quota exceeded, ignore */ }
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      const db = await getDb();
      await new Promise<void>((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* ignore */ }
    localStorage.removeItem(name);
  },
};

const MAX_HISTORY = 100;
const STORAGE_KEY = 'canvas-app-scene';

interface CanvasSnapshot {
  objects: CanvasObject[];
  selectedIds: string[];
  outpaintFrameId: string | null;
  frameCount: number;
}

export interface CanvasScene {
  version: 1;
  exportedAt: string;
  objects: CanvasObject[];
  selectedIds: string[];
  stageX: number;
  stageY: number;
  stageScale: number;
  frameCount: number;
  brushColor: string;
  brushSize: number;
  brushOpacity: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureMin: number;
  shapeType: 'rect' | 'ellipse' | 'line';
  fillColor: string;
  shapeStrokeColor: string;
  shapeStrokeWidth: number;
  fontSize: number;
  fontColor: string;
}

export type ScreenshotTarget =
  | { type: 'viewport' }
  | { type: 'selection' }
  | { type: 'object'; objectId: string }
  | { type: 'bounds'; x: number; y: number; width: number; height: number };

interface CanvasState {
  // Document metadata
  documentId: string;
  documentName: string;
  createdAt: string;
  updatedAt: string;
  renameDocument: (name: string) => void;

  // Theme
  theme: 'dark' | 'light';
  setTheme: (t: 'dark' | 'light') => void;

  // Active tool
  tool: ToolType;
  setTool: (tool: ToolType) => void;
  penMode: boolean;
  setPenMode: (enabled: boolean) => void;
  keepToolActive: boolean;
  setKeepToolActive: (enabled: boolean) => void;

  // Viewport (Konva stage position + scale)
  stageX: number;
  stageY: number;
  stageScale: number;
  setStageTransform: (x: number, y: number, scale: number) => void;

  // All canvas objects
  objects: CanvasObject[];
  addObject: (obj: CanvasObject) => void;
  addObjects: (objs: CanvasObject[], selectedIds?: string[]) => void;
  updateObject: (id: string, updates: Partial<CanvasObject>) => void;
  updateObjects: (updatesById: Record<string, Partial<CanvasObject>>) => void;
  removeObjects: (ids: string[]) => void;
  applyPatch: (patches: CanvasPatch | CanvasPatch[]) => void;
  bringToFront: (id: string) => void;

  // Selection
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;

  // Brush / pen settings
  brushColor: string;
  setBrushColor: (c: string) => void;
  brushSize: number;
  setBrushSize: (s: number) => void;
  brushOpacity: number;
  setBrushOpacity: (o: number) => void;
  pressureSize: boolean;
  setPressureSize: (v: boolean) => void;
  pressureOpacity: boolean;
  setPressureOpacity: (v: boolean) => void;
  pressureMin: number;
  setPressureMin: (v: number) => void;

  // Shape type (rect / ellipse / line) — remembered across tool switches
  shapeType: 'rect' | 'ellipse' | 'line';
  setShapeType: (t: 'rect' | 'ellipse' | 'line') => void;

  // Shape fill/stroke
  fillColor: string;
  setFillColor: (c: string) => void;
  shapeStrokeColor: string;
  setShapeStrokeColor: (c: string) => void;
  shapeStrokeWidth: number;
  setShapeStrokeWidth: (w: number) => void;

  // Text
  fontSize: number;
  setFontSize: (s: number) => void;
  fontColor: string;
  setFontColor: (c: string) => void;

  // Image generation
  isGenerating: boolean;
  setIsGenerating: (v: boolean) => void;
  outpaintFrameId: string | null;
  setOutpaintFrameId: (id: string | null) => void;

  // Context frames for image generation
  contextFrameIds: string[];
  setContextFrameIds: (ids: string[]) => void;
  toggleContextFrame: (id: string) => void;
  contextPickerActive: boolean;
  setContextPickerActive: (v: boolean) => void;
  captureFrameSnapshot: ((frame: FrameObject) => Promise<string>) | null;
  setCaptureFrameSnapshot: (fn: ((frame: FrameObject) => Promise<string>) | null) => void;

  // Recent colors (color picker history)
  recentColors: string[];
  addRecentColor: (c: string) => void;

  // LLM change notifications
  pendingLlmChangeCount: number;
  addPendingLlmChanges: (n: number) => void;
  clearPendingLlmChanges: () => void;
  pendingFocusCenter: { x: number; y: number } | null;
  setPendingFocusCenter: (c: { x: number; y: number } | null) => void;

  // Frame counter for unique labels
  frameCount: number;
  incrementFrameCount: () => number;

  // Scene persistence
  exportScene: () => CanvasScene;
  importScene: (scene: CanvasScene) => void;
  exportDocument: () => CanvasDocument;
  importDocument: (document: CanvasDocument) => void;

  // Screenshot bridge owned by the renderer.
  captureScreenshot: ((target?: ScreenshotTarget, scale?: number) => Promise<string>) | null;
  setCaptureScreenshot: (fn: ((target?: ScreenshotTarget, scale?: number) => Promise<string>) | null) => void;

  // Object history
  past: CanvasSnapshot[];
  future: CanvasSnapshot[];
  canUndo: () => boolean;
  canRedo: () => boolean;
  undo: () => void;
  redo: () => void;
}

function snapshot(s: CanvasState): CanvasSnapshot {
  return {
    objects: s.objects,
    selectedIds: s.selectedIds,
    outpaintFrameId: s.outpaintFrameId,
    frameCount: s.frameCount,
  };
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeObjects(objects: CanvasObject[]): CanvasObject[] {
  return objects.map((obj) => (
    obj.type === 'frame'
      ? { ...obj, generating: false }
      : obj
  ));
}

function filterSelectedIds(selectedIds: string[], objects: CanvasObject[]): string[] {
  const ids = new Set(objects.map((obj) => obj.id));
  return selectedIds.filter((id) => ids.has(id));
}

function touchUpdatedAt(): { updatedAt: string } {
  return { updatedAt: new Date().toISOString() };
}

function sceneFromState(s: CanvasState): CanvasScene {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    objects: sanitizeObjects(s.objects),
    selectedIds: filterSelectedIds(s.selectedIds, s.objects),
    stageX: s.stageX,
    stageY: s.stageY,
    stageScale: s.stageScale,
    frameCount: s.frameCount,
    brushColor: s.brushColor,
    brushSize: s.brushSize,
    brushOpacity: s.brushOpacity,
    pressureSize: s.pressureSize,
    pressureOpacity: s.pressureOpacity,
    pressureMin: s.pressureMin,
    shapeType: s.shapeType,
    fillColor: s.fillColor,
    shapeStrokeColor: s.shapeStrokeColor,
    shapeStrokeWidth: s.shapeStrokeWidth,
    fontSize: s.fontSize,
    fontColor: s.fontColor,
  };
}

function stateFromScene(scene: CanvasScene): Partial<CanvasState> {
  const objects = sanitizeObjects(scene.objects);
  return {
    objects,
    selectedIds: filterSelectedIds(scene.selectedIds ?? [], objects),
    stageX: scene.stageX ?? 0,
    stageY: scene.stageY ?? 0,
    stageScale: scene.stageScale ?? 1,
    frameCount: scene.frameCount ?? objects.filter((obj) => obj.type === 'frame').length,
    brushColor: scene.brushColor ?? '#1a1a1a',
    brushSize: scene.brushSize ?? 6,
    brushOpacity: scene.brushOpacity ?? 1,
    pressureSize: scene.pressureSize ?? true,
    pressureOpacity: scene.pressureOpacity ?? false,
    pressureMin: scene.pressureMin ?? 0.25,
    shapeType: scene.shapeType ?? 'rect',
    fillColor: scene.fillColor ?? 'transparent',
    shapeStrokeColor: scene.shapeStrokeColor ?? '#1a1a1a',
    shapeStrokeWidth: scene.shapeStrokeWidth ?? 2,
    fontSize: scene.fontSize ?? 24,
    fontColor: scene.fontColor ?? '#1a1a1a',
    outpaintFrameId: null,
    contextFrameIds: [],
    contextPickerActive: false,
    isGenerating: false,
  };
}

function documentFromState(s: CanvasState): CanvasDocument {
  return {
    version: 1,
    id: s.documentId,
    name: s.documentName,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    objects: sanitizeObjects(s.objects),
    selectedIds: filterSelectedIds(s.selectedIds, s.objects),
    viewport: {
      x: s.stageX,
      y: s.stageY,
      scale: s.stageScale,
    },
  };
}

function stateFromDocument(document: CanvasDocument): Partial<CanvasState> {
  const objects = sanitizeObjects(document.objects);
  return {
    documentId: document.id,
    documentName: document.name,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    objects,
    selectedIds: filterSelectedIds(document.selectedIds ?? [], objects),
    stageX: document.viewport?.x ?? 0,
    stageY: document.viewport?.y ?? 0,
    stageScale: document.viewport?.scale ?? 1,
    frameCount: objects.filter((obj) => obj.type === 'frame').length,
    outpaintFrameId: null,
    contextFrameIds: [],
    contextPickerActive: false,
    isGenerating: false,
  };
}

function persistedState(s: CanvasState): Partial<CanvasState> {
  const scene = sceneFromState(s);
  return {
    ...stateFromScene(scene),
    theme: s.theme,
    penMode: s.penMode,
    keepToolActive: s.keepToolActive,
    tool: s.tool,
    recentColors: s.recentColors,
    documentId: s.documentId,
    documentName: s.documentName,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function sanitizePersistedState(value: unknown): Partial<CanvasState> {
  if (!value || typeof value !== 'object') return {};
  const state = value as Partial<CanvasState>;
  return {
    ...state,
    theme: state.theme === 'light' ? 'light' : 'dark',
    objects: sanitizeObjects(Array.isArray(state.objects) ? state.objects : []),
    selectedIds: Array.isArray(state.selectedIds) && Array.isArray(state.objects)
      ? filterSelectedIds(state.selectedIds, state.objects)
      : [],
    isGenerating: false,
    outpaintFrameId: null,
    contextFrameIds: [],
    contextPickerActive: false,
    past: [],
    future: [],
    recentColors: Array.isArray(state.recentColors) ? state.recentColors.slice(0, 12) : [],
    documentId: typeof state.documentId === 'string' ? state.documentId : makeId('doc'),
    documentName: typeof state.documentName === 'string' ? state.documentName : 'Untitled canvas',
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : new Date().toISOString(),
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : new Date().toISOString(),
  };
}

function withHistory(
  s: CanvasState,
  updates: Partial<CanvasState>,
): Partial<CanvasState> {
  return {
    ...updates,
    past: [...s.past, snapshot(s)].slice(-MAX_HISTORY),
    future: [],
  };
}

export const useCanvasStore = create<CanvasState>()(persist((set, get) => ({
  documentId: makeId('doc'),
  documentName: 'Untitled canvas',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  renameDocument: (name) => set({ documentName: name.trim() || 'Untitled canvas', ...touchUpdatedAt() }),

  theme: 'light',
  setTheme: (t) => set({ theme: t }),

  tool: 'pen',
  setTool: (tool) => set({ tool }),
  penMode: true,
  setPenMode: (enabled) => set({ penMode: enabled }),
  keepToolActive: false,
  setKeepToolActive: (enabled) => set({ keepToolActive: enabled }),

  stageX: 0,
  stageY: 0,
  stageScale: 1,
  setStageTransform: (x, y, scale) => set({ stageX: x, stageY: y, stageScale: scale, ...touchUpdatedAt() }),

  objects: [],
  addObject: (obj) => set((s) => withHistory(s, { objects: [...s.objects, obj], ...touchUpdatedAt() })),
  addObjects: (objs, selectedIds) =>
    set((s) => {
      if (objs.length === 0) return {};
      return withHistory(s, {
        objects: [...s.objects, ...objs],
        selectedIds: selectedIds ?? s.selectedIds,
        ...touchUpdatedAt(),
      });
    }),
  updateObject: (id, updates) =>
    set((s) => {
      if (!s.objects.some((o) => o.id === id)) return {};
      return withHistory(s, {
        objects: s.objects.map((o) =>
          o.id === id ? ({ ...o, ...updates } as CanvasObject) : o,
        ),
        ...touchUpdatedAt(),
      });
    }),
  updateObjects: (updatesById) =>
    set((s) => {
      const ids = new Set(Object.keys(updatesById));
      if (!s.objects.some((o) => ids.has(o.id))) return {};
      return withHistory(s, {
        objects: s.objects.map((o) =>
          ids.has(o.id) ? ({ ...o, ...updatesById[o.id] } as CanvasObject) : o,
        ),
        ...touchUpdatedAt(),
      });
    }),
  removeObjects: (ids) =>
    set((s) => {
      if (!s.objects.some((o) => ids.includes(o.id))) return {};
      return withHistory(s, {
        objects: s.objects.filter((o) => !ids.includes(o.id)),
        selectedIds: s.selectedIds.filter((id) => !ids.includes(id)),
        ...touchUpdatedAt(),
      });
    }),
  applyPatch: (input) =>
    set((s) => {
      const patches = Array.isArray(input) ? input : [input];
      if (patches.length === 0) return {};
      let objects = s.objects;
      let selectedIds = s.selectedIds;
      let stageX = s.stageX;
      let stageY = s.stageY;
      let stageScale = s.stageScale;
      let changed = false;

      for (const patch of patches) {
        if (patch.op === 'create' && patch.objects.length > 0) {
          const existingIds = new Set(objects.map((obj) => obj.id));
          const newObjects = patch.objects.filter((obj) => !existingIds.has(obj.id));
          if (newObjects.length > 0) {
            objects = [...objects, ...newObjects];
            if (patch.select) selectedIds = newObjects.map((obj) => obj.id);
            changed = true;
          }
        } else if (patch.op === 'update') {
          let didUpdate = false;
          objects = objects.map((obj) => {
            if (obj.id !== patch.id) return obj;
            didUpdate = true;
            return { ...obj, ...patch.changes } as CanvasObject;
          });
          changed ||= didUpdate;
        } else if (patch.op === 'delete') {
          const ids = new Set(patch.ids);
          const nextObjects = objects.filter((obj) => !ids.has(obj.id));
          if (nextObjects.length !== objects.length) {
            objects = nextObjects;
            selectedIds = selectedIds.filter((id) => !ids.has(id));
            changed = true;
          }
        } else if (patch.op === 'select') {
          selectedIds = filterSelectedIds(patch.ids, objects);
          changed = true;
        } else if (patch.op === 'viewport') {
          stageX = patch.x;
          stageY = patch.y;
          stageScale = patch.scale;
          changed = true;
        }
      }

      if (!changed) return {};
      return withHistory(s, {
        objects,
        selectedIds: filterSelectedIds(selectedIds, objects),
        stageX,
        stageY,
        stageScale,
        ...touchUpdatedAt(),
      });
    }),
  bringToFront: (id) =>
    set((s) => {
      const obj = s.objects.find((o) => o.id === id);
      if (!obj) return s;
      return { objects: [...s.objects.filter((o) => o.id !== id), obj] };
    }),

  selectedIds: [],
  setSelectedIds: (ids) => set((s) => ({ selectedIds: filterSelectedIds(ids, s.objects) })),

  brushColor: '#1a1a1a',
  setBrushColor: (c) => set({ brushColor: c }),
  brushSize: 6,
  setBrushSize: (s) => set({ brushSize: s }),
  brushOpacity: 1,
  setBrushOpacity: (o) => set({ brushOpacity: o }),
  pressureSize: true,
  setPressureSize: (v) => set({ pressureSize: v }),
  pressureOpacity: false,
  setPressureOpacity: (v) => set({ pressureOpacity: v }),
  pressureMin: 0.25,
  setPressureMin: (v) => set({ pressureMin: v }),

  shapeType: 'rect',
  setShapeType: (t) => set({ shapeType: t }),

  fillColor: 'transparent',
  setFillColor: (c) => set({ fillColor: c }),
  shapeStrokeColor: '#1a1a1a',
  setShapeStrokeColor: (c) => set({ shapeStrokeColor: c }),
  shapeStrokeWidth: 2,
  setShapeStrokeWidth: (w) => set({ shapeStrokeWidth: w }),

  fontSize: 24,
  setFontSize: (s) => set({ fontSize: s }),
  fontColor: '#1a1a1a',
  setFontColor: (c) => set({ fontColor: c }),

  isGenerating: false,
  setIsGenerating: (v) => set({ isGenerating: v }),
  outpaintFrameId: null,
  setOutpaintFrameId: (id) => set({ outpaintFrameId: id }),

  contextFrameIds: [],
  setContextFrameIds: (ids) => set({ contextFrameIds: ids }),
  toggleContextFrame: (id) =>
    set((s) => ({
      contextFrameIds: s.contextFrameIds.includes(id)
        ? s.contextFrameIds.filter((x) => x !== id)
        : [...s.contextFrameIds, id],
    })),
  contextPickerActive: false,
  setContextPickerActive: (v) => set({ contextPickerActive: v }),
  captureFrameSnapshot: null,
  setCaptureFrameSnapshot: (fn) => set({ captureFrameSnapshot: fn }),

  recentColors: [],
  addRecentColor: (c) =>
    set((s) => ({
      recentColors: [c, ...s.recentColors.filter((r) => r !== c)].slice(0, 12),
    })),

  pendingLlmChangeCount: 0,
  addPendingLlmChanges: (n) => set((s) => ({ pendingLlmChangeCount: s.pendingLlmChangeCount + n })),
  clearPendingLlmChanges: () => set({ pendingLlmChangeCount: 0 }),
  pendingFocusCenter: null,
  setPendingFocusCenter: (c) => set({ pendingFocusCenter: c }),

  frameCount: 0,
  incrementFrameCount: () => {
    const next = get().frameCount + 1;
    set({ frameCount: next });
    return next;
  },

  exportScene: () => sceneFromState(get()),
  importScene: (scene) =>
    set((s) => withHistory(s, { ...stateFromScene(scene), ...touchUpdatedAt() })),
  exportDocument: () => documentFromState(get()),
  importDocument: (document) =>
    set((s) => withHistory(s, stateFromDocument(document))),

  captureScreenshot: null,
  setCaptureScreenshot: (fn) => set({ captureScreenshot: fn }),

  past: [],
  future: [],
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  undo: () =>
    set((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous) return {};
      return {
        ...previous,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, MAX_HISTORY),
      };
    }),
  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return {
        ...next,
        past: [...s.past, snapshot(s)].slice(-MAX_HISTORY),
        future: s.future.slice(1),
      };
    }),
}), {
  name: STORAGE_KEY,
  version: 1,
  storage: createJSONStorage(() => idbStorage),
  partialize: persistedState,
  merge: (persisted, current) => ({
    ...current,
    ...sanitizePersistedState(persisted),
  }),
}));
