import { nanoid } from 'nanoid';
import { ScreenshotTarget, useCanvasStore } from '../store/useCanvasStore';
import {
  ArrowObject,
  CanvasObject,
  CanvasPatch,
  FrameObject,
  ProjectLink,
  TextObject,
} from '../types/canvas';

type Bounds = { x: number; y: number; width: number; height: number };

const GUIDES: Record<string, string> = {
  'canvas-mcp-instructions': [
    'Canvas is a live visual collaboration surface. Read the document and selection before editing.',
    'Prefer incremental object patches over replacing the whole scene.',
    'Use stable object IDs returned by read tools. Name frames and major groups clearly.',
    'After meaningful visual changes, request a screenshot before continuing.',
    'Ask before destructive changes that delete many objects or unlink projects.',
    'Use working indicators while editing visible objects, frames, embeds, or regions.',
  ].join('\n'),
  'mermaid-to-canvas': [
    'Mermaid diagrams should become native editable objects.',
    'Represent nodes as rect, ellipse, or text objects; represent edges as line or arrow objects.',
    'Keep original Mermaid source in metadata when that field is available.',
    'Group-level Mermaid import is not implemented yet, so create native objects in batches.',
  ].join('\n'),
  'project-preview-workflow': [
    'Project previews are links to independent repos and preview URLs.',
    'Canvas stores project metadata only; the project must keep building without Canvas.',
    'Create or update a site frame for the preview URL, then read annotations attached to that frame.',
  ].join('\n'),
  'annotation-workflow': [
    'Treat text, arrows, strokes, and comments attached by parentId or parentFrameId as annotations.',
    'Use annotation text as user intent, and use arrows or strokes as location guidance.',
    'Do not bake visible annotation marks into final generated images unless the user asks for it.',
  ].join('\n'),
};

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

function createFrameObject(input: Partial<FrameObject> & Pick<FrameObject, 'x' | 'y' | 'width' | 'height'>): FrameObject {
  const state = useCanvasStore.getState();
  return {
    id: input.id ?? nanoid(),
    type: 'frame',
    kind: input.kind ?? 'plain',
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    label: input.label ?? `Frame ${state.frameCount + 1}`,
    background: input.background ?? (input.kind === 'site' ? '#ffffff' : '#181818'),
    url: input.url ?? null,
    imageData: input.imageData ?? null,
    generating: false,
    priorBounds: null,
  };
}

function normalizeCreatedObject(object: CanvasObject): CanvasObject {
  if (object.id) return object;
  return { ...object, id: nanoid() } as CanvasObject;
}

export const canvasMcpTools = {
  get_guide(topic = 'canvas-mcp-instructions') {
    return {
      topic,
      guide: GUIDES[topic] ?? GUIDES['canvas-mcp-instructions'],
      availableTopics: Object.keys(GUIDES),
    };
  },

  get_basic_info() {
    const state = useCanvasStore.getState();
    const counts = state.objects.reduce<Record<string, number>>((acc, obj) => {
      acc[obj.type] = (acc[obj.type] ?? 0) + 1;
      return acc;
    }, {});
    return {
      document: {
        id: state.documentId,
        name: state.documentName,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
      objectCounts: counts,
      viewport: { x: state.stageX, y: state.stageY, scale: state.stageScale },
      selectedIds: state.selectedIds,
      linkedProjects: state.links,
      activeTool: state.tool,
      availableFonts: ['system-ui', '-apple-system', 'Segoe UI', 'Arial', 'sans-serif'],
    };
  },

  get_document() {
    return useCanvasStore.getState().exportDocument();
  },

  get_selection() {
    const state = useCanvasStore.getState();
    return state.selectedIds
      .map((id) => state.objects.find((obj) => obj.id === id))
      .filter((obj): obj is CanvasObject => !!obj);
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

  get_annotations(targetId: string) {
    const state = useCanvasStore.getState();
    const target = state.objects.find((obj) => obj.id === targetId);
    return {
      target: target ? { id: target.id, type: target.type, url: target.type === 'frame' ? target.url : undefined } : null,
      annotations: state.objects
        .filter((obj) => objectParentId(obj) === targetId)
        .filter((obj) => obj.type === 'text' || obj.type === 'arrow' || obj.type === 'stroke' || obj.type === 'comment')
        .map((obj) => {
          if (obj.type === 'text' || obj.type === 'comment') return { id: obj.id, type: obj.type, text: obj.text, bounds: objectBounds(obj) };
          if (obj.type === 'arrow') return { id: obj.id, type: 'arrow', from: { x: obj.x1, y: obj.y1 }, to: { x: obj.x2, y: obj.y2 } };
          return { id: obj.id, type: 'stroke', bounds: objectBounds(obj), points: obj.points };
        }),
    };
  },

  async get_screenshot(target?: ScreenshotTarget, scale?: number) {
    const capture = useCanvasStore.getState().captureScreenshot;
    if (!capture) throw new Error('Screenshot capture is not ready.');
    return { imageData: await capture(target, scale) };
  },

  get_linked_projects() {
    return useCanvasStore.getState().links;
  },

  create_frame(input: Partial<FrameObject> & Pick<FrameObject, 'x' | 'y' | 'width' | 'height'>) {
    const frame = createFrameObject(input);
    const state = useCanvasStore.getState();
    state.addObject(frame);
    state.incrementFrameCount();
    state.setSelectedIds([frame.id]);
    return frame;
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

  set_text_content(objectId: string, text: string) {
    const obj = useCanvasStore.getState().objects.find((item) => item.id === objectId);
    if (!obj || (obj.type !== 'text' && obj.type !== 'comment')) throw new Error('Object is not text-like.');
    useCanvasStore.getState().applyPatch({ op: 'update', id: objectId, changes: { text } as Partial<TextObject> });
    return { id: objectId, text };
  },

  move_objects(ids: string[], dx: number, dy: number) {
    const state = useCanvasStore.getState();
    const updates = state.objects
      .filter((obj) => ids.includes(obj.id))
      .map((obj) => ({ op: 'update' as const, id: obj.id, changes: shiftObject(obj, dx, dy) }));
    state.applyPatch(updates);
    return { movedIds: updates.map((item) => item.id), dx, dy };
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

  rename_objects(items: Array<{ id: string; name: string }>) {
    const patches: CanvasPatch[] = items.map(({ id, name }) => ({ op: 'update', id, changes: { label: name } as Partial<CanvasObject> }));
    useCanvasStore.getState().applyPatch(patches);
    return { renamedIds: items.map((item) => item.id) };
  },

  apply_patch(patch: CanvasPatch | CanvasPatch[]) {
    useCanvasStore.getState().applyPatch(patch);
    return { ok: true };
  },

  create_project_preview(projectId: string, url: string, bounds: Bounds = { x: 0, y: 0, width: 1024, height: 768 }) {
    const link = useCanvasStore.getState().links.find((item) => item.id === projectId);
    const frame = canvasMcpTools.create_frame({
      kind: 'site',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      label: link?.name ? `${link.name} preview` : 'Project preview',
      url,
      background: '#ffffff',
    });
    if (link) useCanvasStore.getState().setPreviewUrl(projectId, url);
    return frame;
  },

  link_project(project: Omit<ProjectLink, 'id' | 'kind' | 'createdAt'> & Partial<Pick<ProjectLink, 'id' | 'createdAt'>>) {
    return useCanvasStore.getState().linkProject(project);
  },

  unlink_project(projectId: string) {
    useCanvasStore.getState().unlinkProject(projectId);
    return { unlinkedId: projectId };
  },

  set_preview_url(projectId: string, previewUrl: string | undefined) {
    useCanvasStore.getState().setPreviewUrl(projectId, previewUrl);
    return { projectId, previewUrl };
  },

  mark_working(ids: string[]) {
    useCanvasStore.getState().markWorking(ids);
    return { workingIds: useCanvasStore.getState().workingObjectIds };
  },

  finish_working(ids?: string[]) {
    useCanvasStore.getState().finishWorking(ids);
    return { workingIds: useCanvasStore.getState().workingObjectIds };
  },
};

export type CanvasMcpTools = typeof canvasMcpTools;
