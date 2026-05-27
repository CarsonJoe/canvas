import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');
export const workspaceRoot = path.resolve(process.cwd());
export const canvasDir = path.join(workspaceRoot, '.canvas');
export const assetsDir = path.join(canvasDir, 'assets');
export const runtimeDir = path.join(canvasDir, 'runtime');
export const documentPath = path.join(canvasDir, 'canvas.json');
export const screenshotRequestPath = path.join(runtimeDir, 'screenshot-request.json');
export const screenshotResponsePath = path.join(runtimeDir, 'screenshot-response.json');
export const logsDir = path.join(runtimeDir, 'logs');
export let appPort = Number(process.env.CANVAS_PORT ?? 3762);
export const appHost = '127.0.0.1';
export let appUrl = `http://${appHost}:${appPort}`;
export let mcpHttpUrl = `${appUrl}/mcp`;

export function setAppPort(port) {
  appPort = port;
  appUrl = `http://${appHost}:${port}`;
  mcpHttpUrl = `${appUrl}/mcp`;
}
export const helperVersion = process.env.COGNIBOOM_CANVAS_HELPER_VERSION ?? '0.1.0';
export const appVersion = process.env.COGNIBOOM_CANVAS_APP_VERSION ?? '0.1.0';

export function now() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultDocument() {
  const timestamp = now();
  return {
    version: 1,
    id: makeId('doc'),
    name: 'Untitled canvas',
    createdAt: timestamp,
    updatedAt: timestamp,
    objects: [],
    selectedIds: [],
    viewport: { x: 0, y: 0, scale: 1 },
  };
}

export async function ensureDataDir() {
  await fs.mkdir(canvasDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
}

export async function readAssetSource(id) {
  const candidates = [
    { filePath: path.join(assetsDir, `${id}.md`), format: 'markdown' },
    { filePath: path.join(assetsDir, `${id}.html`), format: 'html' },
    { filePath: path.join(assetsDir, `${id}.svg`), format: 'svg' },
  ];
  for (const candidate of candidates) {
    try {
      return {
        content: await fs.readFile(candidate.filePath, 'utf8'),
        format: candidate.format,
        filePath: candidate.filePath,
      };
    } catch {}
  }
  return null;
}

export async function writeAssetSource(id, content, format) {
  await ensureDataDir();
  const ext = format === 'html' ? 'html' : format === 'svg' ? 'svg' : 'md';
  const filePath = path.join(assetsDir, `${id}.${ext}`);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

export async function assetMtime(id) {
  for (const ext of ['md', 'html', 'svg']) {
    try {
      const stat = await fs.stat(path.join(assetsDir, `${id}.${ext}`));
      return stat.mtimeMs;
    } catch {}
  }
  return null;
}

export async function readDocument() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(documentPath, 'utf8');
    if (!raw.trim()) throw Object.assign(new Error('Empty document'), { code: 'EMPTY_DOCUMENT' });
    return normalizeDocument(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== 'ENOENT' && error.code !== 'EMPTY_DOCUMENT' && !(error instanceof SyntaxError)) throw error;
    const document = defaultDocument();
    await writeDocument(document);
    return document;
  }
}

export async function writeDocument(document) {
  await ensureDataDir();
  const normalized = normalizeDocument(document);
  await fs.writeFile(documentPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function readScreenshotRequest() {
  await ensureDataDir();
  try {
    const parsed = JSON.parse(await fs.readFile(screenshotRequestPath, 'utf8'));
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeScreenshotRequest(request) {
  await ensureDataDir();
  await fs.writeFile(screenshotRequestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return request;
}

export async function readScreenshotResponse() {
  await ensureDataDir();
  try {
    const parsed = JSON.parse(await fs.readFile(screenshotResponsePath, 'utf8'));
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeScreenshotResponse(response) {
  await ensureDataDir();
  await fs.writeFile(screenshotResponsePath, `${JSON.stringify(response, null, 2)}\n`, 'utf8');
  return response;
}

export async function waitForScreenshotResponse(id, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await readScreenshotResponse();
    if (response?.id === id) return response;
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  throw new Error('Timed out waiting for the open Canvas app to capture a screenshot.');
}

export function normalizeDocument(value) {
  if (!value || typeof value !== 'object') return defaultDocument();
  const timestamp = now();
  const objects = Array.isArray(value.objects) ? value.objects : [];
  const objectIds = new Set(objects.map((object) => object && object.id).filter(Boolean));
  return {
    version: 1,
    id: typeof value.id === 'string' ? value.id : makeId('doc'),
    name: typeof value.name === 'string' ? value.name : 'Untitled canvas',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp,
    objects,
    selectedIds: Array.isArray(value.selectedIds)
      ? value.selectedIds.filter((id) => objectIds.has(id))
      : [],
    viewport: {
      x: typeof value.viewport?.x === 'number' ? value.viewport.x : 0,
      y: typeof value.viewport?.y === 'number' ? value.viewport.y : 0,
      scale: typeof value.viewport?.scale === 'number' ? value.viewport.scale : 1,
    },
  };
}

export function normalizeCanvasObject(object) {
  if (!object || typeof object !== 'object') return null;
  const id = typeof object.id === 'string' && object.id ? object.id : makeId(object.type || 'object');

  if (object.type === 'frame') {
    const contentKinds = ['html', 'markdown', 'mermaid', 'svg'];
    const isContent = contentKinds.includes(object.kind);
    return {
      id,
      type: 'frame',
      kind: object.kind || 'plain',
      x: Number.isFinite(object.x) ? object.x : 0,
      y: Number.isFinite(object.y) ? object.y : 0,
      width: Number.isFinite(object.width) ? object.width : (isContent ? 640 : 320),
      height: Number.isFinite(object.height) ? object.height : (isContent ? 480 : 180),
      label: typeof object.label === 'string' ? object.label : (isContent ? String(object.kind).charAt(0).toUpperCase() + String(object.kind).slice(1) : 'Frame'),
      background: typeof object.background === 'string' ? object.background : (object.kind === 'site' ? '#ffffff' : '#181818'),
      url: object.url ?? null,
      imageData: object.imageData ?? null,
      generating: false,
      priorBounds: object.priorBounds ?? null,
      ...(isContent && typeof object.source === 'string' ? { source: object.source } : {}),
      ...(isContent && object.flatten != null ? { flatten: !!object.flatten } : {}),
    };
  }

  if (object.type === 'text') {
    return {
      id,
      type: 'text',
      parentFrameId: object.parentFrameId ?? object.parentId ?? null,
      parentId: object.parentId ?? object.parentFrameId ?? null,
      x: Number.isFinite(object.x) ? object.x : 0,
      y: Number.isFinite(object.y) ? object.y : 0,
      text: typeof object.text === 'string' ? object.text : '',
      fontSize: Number.isFinite(object.fontSize) ? object.fontSize : 24,
      color: typeof object.color === 'string' ? object.color : '#ffffff',
      fontFamily: typeof object.fontFamily === 'string' ? object.fontFamily : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    };
  }

  if (object.type === 'comment') {
    return {
      id,
      type: 'comment',
      parentFrameId: object.parentFrameId ?? object.parentId ?? null,
      parentId: object.parentId ?? object.parentFrameId ?? null,
      x: Number.isFinite(object.x) ? object.x : 0,
      y: Number.isFinite(object.y) ? object.y : 0,
      text: typeof object.text === 'string' ? object.text : '',
      resolved: !!object.resolved,
      createdAt: typeof object.createdAt === 'string' ? object.createdAt : now(),
    };
  }

  return { ...object, id };
}

export function objectBounds(object) {
  if (!object || typeof object !== 'object') return null;
  if (object.type === 'rect') return { x: object.x, y: object.y, width: object.width, height: object.height };
  if (object.type === 'ellipse') return { x: object.x - object.radiusX, y: object.y - object.radiusY, width: object.radiusX * 2, height: object.radiusY * 2 };
  if (object.type === 'frame') return { x: object.x, y: object.y, width: object.width, height: object.height };
  if (object.type === 'line' || object.type === 'arrow') {
    return {
      x: Math.min(object.x1, object.x2),
      y: Math.min(object.y1, object.y2),
      width: Math.abs(object.x2 - object.x1),
      height: Math.abs(object.y2 - object.y1),
    };
  }
  if (object.type === 'text' || object.type === 'comment') {
    const fontSize = object.type === 'text' ? (object.fontSize ?? 24) : 14;
    const lines = String(object.text ?? '').split('\n');
    const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return { x: object.x, y: object.y - fontSize, width: longestLine * fontSize * 0.6, height: lines.length * fontSize * 1.4 };
  }
  if (object.type === 'stroke' && Array.isArray(object.points) && object.points.length >= 2) {
    const xs = object.points.filter((_, index) => index % 2 === 0);
    const ys = object.points.filter((_, index) => index % 2 === 1);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return null;
}

export function objectParentId(object) {
  return object?.parentId ?? object?.parentFrameId ?? null;
}

export function shiftObject(object, dx, dy, id = object.id) {
  if (object.type === 'rect') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'ellipse') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'text' || object.type === 'comment') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'line') return { ...object, id, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
  if (object.type === 'arrow') {
    return {
      ...object,
      id,
      x1: object.x1 + dx,
      y1: object.y1 + dy,
      x2: object.x2 + dx,
      y2: object.y2 + dy,
      ...(object.cx != null ? { cx: object.cx + dx, cy: (object.cy ?? object.y1) + dy } : {}),
    };
  }
  if (object.type === 'stroke') {
    return { ...object, id, points: object.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) };
  }
  return {
    ...object,
    id,
    x: object.x + dx,
    y: object.y + dy,
    priorBounds: object.priorBounds
      ? { ...object.priorBounds, x: object.priorBounds.x + dx, y: object.priorBounds.y + dy }
      : null,
  };
}

export async function applyPatches(patches) {
  const document = await readDocument();
  const list = Array.isArray(patches) ? patches : [patches];
  let objects = document.objects;
  let selectedIds = document.selectedIds;
  let viewport = document.viewport;

  for (const patch of list) {
    if (!patch || typeof patch !== 'object') continue;
    if (patch.op === 'create' && Array.isArray(patch.objects)) {
      const existing = new Set(objects.map((object) => object.id));
      const created = patch.objects
        .map(normalizeCanvasObject)
        .filter((object) => object && typeof object.id === 'string' && !existing.has(object.id));
      objects = [...objects, ...created];
      if (patch.select) selectedIds = created.map((object) => object.id);
    } else if (patch.op === 'update' && typeof patch.id === 'string') {
      objects = objects.map((object) => object.id === patch.id ? { ...object, ...patch.changes } : object);
    } else if (patch.op === 'delete' && Array.isArray(patch.ids)) {
      const ids = new Set(patch.ids);
      objects = objects.filter((object) => !ids.has(object.id));
      selectedIds = selectedIds.filter((id) => !ids.has(id));
    } else if (patch.op === 'select' && Array.isArray(patch.ids)) {
      const ids = new Set(objects.map((object) => object.id));
      selectedIds = patch.ids.filter((id) => ids.has(id));
    } else if (patch.op === 'viewport') {
      viewport = { x: patch.x, y: patch.y, scale: patch.scale };
    }
  }

  return writeDocument({ ...document, objects, selectedIds, viewport, updatedAt: now() });
}

export const changesPath = path.join(runtimeDir, 'changes.ndjson');

let _nextChangeSeq = null;

async function nextChangeSeq() {
  if (_nextChangeSeq !== null) return ++_nextChangeSeq;
  try {
    const text = await fs.readFile(changesPath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    _nextChangeSeq = typeof last?.seq === 'number' ? last.seq : 0;
  } catch {
    _nextChangeSeq = 0;
  }
  return ++_nextChangeSeq;
}

export async function appendChange({ author, op, objectIds = [], focusId = null }) {
  let focusCenter = null;
  if (focusId) {
    try {
      const doc = await readDocument();
      const obj = doc.objects.find((o) => o.id === focusId);
      const b = objectBounds(obj);
      if (b) focusCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } catch { /* ignore */ }
  }
  const seq = await nextChangeSeq();
  const entry = JSON.stringify({ seq, ts: now(), author, op, objectIds, focusId, focusCenter });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.appendFile(changesPath, entry + '\n', 'utf8');
  return seq;
}

export async function readChangesSince(seq) {
  try {
    const text = await fs.readFile(changesPath, 'utf8');
    return text.trim().split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e) => e && typeof e.seq === 'number' && e.seq > seq);
  } catch {
    return [];
  }
}

export async function latestChangeSeq() {
  try {
    const text = await fs.readFile(changesPath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    if (!lines.length) return 0;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last?.seq === 'number' ? last.seq : 0;
  } catch {
    return 0;
  }
}

export function summarizeDocument(document) {
  const objectCounts = {};
  for (const object of document.objects) {
    objectCounts[object.type] = (objectCounts[object.type] ?? 0) + 1;
  }
  return {
    document: {
      id: document.id,
      name: document.name,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    },
    objectCounts,
    viewport: document.viewport,
    selectedIds: document.selectedIds,
  };
}
