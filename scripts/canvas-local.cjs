const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = process.cwd();
const localDataDir = path.join(repoRoot, '.canvas-local');
const documentPath = path.join(localDataDir, 'current.canvas.json');
const workingPath = path.join(localDataDir, 'working.json');
const screenshotRequestPath = path.join(localDataDir, 'screenshot-request.json');
const screenshotResponsePath = path.join(localDataDir, 'screenshot-response.json');
const distDir = path.join(repoRoot, 'dist');
const port = Number(process.env.CANVAS_PORT || 3762);
const host = '127.0.0.1';

function now() { return new Date().toISOString(); }
function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function ensureDataDirSync() { fs.mkdirSync(localDataDir, { recursive: true }); }
function defaultDocument() {
  const timestamp = now();
  return { version: 1, id: makeId('doc'), name: 'Untitled canvas', createdAt: timestamp, updatedAt: timestamp, objects: [], selectedIds: [], viewport: { x: 0, y: 0, scale: 1 }, links: [] };
}
function normalizeDocument(value) {
  if (!value || typeof value !== 'object') return defaultDocument();
  const timestamp = now();
  const objects = Array.isArray(value.objects) ? value.objects : [];
  const ids = new Set(objects.map((object) => object && object.id).filter(Boolean));
  return {
    version: 1,
    id: typeof value.id === 'string' ? value.id : makeId('doc'),
    name: typeof value.name === 'string' ? value.name : 'Untitled canvas',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp,
    objects,
    selectedIds: Array.isArray(value.selectedIds) ? value.selectedIds.filter((id) => ids.has(id)) : [],
    viewport: { x: value.viewport?.x || 0, y: value.viewport?.y || 0, scale: value.viewport?.scale || 1 },
    links: Array.isArray(value.links) ? value.links : [],
  };
}
async function readDocument() {
  ensureDataDirSync();
  try {
    const raw = await fsp.readFile(documentPath, 'utf8');
    if (!raw.trim()) throw Object.assign(new Error('Empty document'), { code: 'EMPTY_DOCUMENT' });
    return normalizeDocument(JSON.parse(raw));
  }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EMPTY_DOCUMENT' && !(error instanceof SyntaxError)) throw error;
    const document = defaultDocument();
    await writeDocument(document);
    return document;
  }
}
async function writeDocument(document) {
  ensureDataDirSync();
  const normalized = normalizeDocument(document);
  await fsp.writeFile(documentPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}
async function readWorkingIds() {
  ensureDataDirSync();
  try {
    const parsed = JSON.parse(await fsp.readFile(workingPath, 'utf8'));
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === 'string') : [];
  } catch { return []; }
}
async function writeWorkingIds(ids) {
  ensureDataDirSync();
  const uniqueIds = Array.from(new Set((ids || []).filter((id) => typeof id === 'string')));
  await fsp.writeFile(workingPath, `${JSON.stringify({ ids: uniqueIds, updatedAt: now() }, null, 2)}\n`, 'utf8');
  return uniqueIds;
}
async function readScreenshotRequest() {
  ensureDataDirSync();
  try {
    const parsed = JSON.parse(await fsp.readFile(screenshotRequestPath, 'utf8'));
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch { return null; }
}
async function writeScreenshotRequest(request) {
  ensureDataDirSync();
  await fsp.writeFile(screenshotRequestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return request;
}
async function readScreenshotResponse() {
  ensureDataDirSync();
  try {
    const parsed = JSON.parse(await fsp.readFile(screenshotResponsePath, 'utf8'));
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch { return null; }
}
async function writeScreenshotResponse(response) {
  ensureDataDirSync();
  await fsp.writeFile(screenshotResponsePath, `${JSON.stringify(response, null, 2)}\n`, 'utf8');
  return response;
}
async function waitForScreenshotResponse(id, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await readScreenshotResponse();
    if (response?.id === id) return response;
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  throw new Error('Timed out waiting for the open Canvas app to capture a screenshot.');
}
function normalizeCanvasObject(object) {
  if (!object || typeof object !== 'object') return null;
  const id = typeof object.id === 'string' && object.id ? object.id : makeId(object.type || 'object');
  if (object.type === 'frame') {
    return {
      id,
      type: 'frame',
      kind: object.kind || 'plain',
      x: Number.isFinite(object.x) ? object.x : 0,
      y: Number.isFinite(object.y) ? object.y : 0,
      width: Number.isFinite(object.width) ? object.width : 320,
      height: Number.isFinite(object.height) ? object.height : 180,
      label: typeof object.label === 'string' ? object.label : 'Frame',
      background: typeof object.background === 'string' ? object.background : (object.kind === 'site' ? '#ffffff' : '#181818'),
      url: object.url ?? null,
      imageData: object.imageData ?? null,
      generating: false,
      priorBounds: object.priorBounds ?? null,
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
function objectBounds(object) {
  if (!object) return null;
  if (object.type === 'rect') return { x: object.x, y: object.y, width: object.width, height: object.height };
  if (object.type === 'ellipse') return { x: object.x - object.radiusX, y: object.y - object.radiusY, width: object.radiusX * 2, height: object.radiusY * 2 };
  if (object.type === 'frame') return { x: object.x, y: object.y, width: object.width, height: object.height };
  if (object.type === 'line' || object.type === 'arrow') return { x: Math.min(object.x1, object.x2), y: Math.min(object.y1, object.y2), width: Math.abs(object.x2 - object.x1), height: Math.abs(object.y2 - object.y1) };
  if (object.type === 'text' || object.type === 'comment') {
    const fontSize = object.type === 'text' ? object.fontSize : 14;
    return { x: object.x, y: object.y - fontSize, width: String(object.text || '').length * fontSize * 0.6, height: fontSize * 1.2 };
  }
  if (object.type === 'stroke' && Array.isArray(object.points) && object.points.length >= 2) {
    const xs = object.points.filter((_, i) => i % 2 === 0);
    const ys = object.points.filter((_, i) => i % 2 === 1);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return null;
}
function objectParentId(object) { return object?.parentId || object?.parentFrameId || null; }
function shiftObject(object, dx, dy, id = object.id) {
  if (object.type === 'rect') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'ellipse') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'text' || object.type === 'comment') return { ...object, id, x: object.x + dx, y: object.y + dy };
  if (object.type === 'line') return { ...object, id, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
  if (object.type === 'arrow') return { ...object, id, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy, ...(object.cx != null ? { cx: object.cx + dx, cy: (object.cy || object.y1) + dy } : {}) };
  if (object.type === 'stroke') return { ...object, id, points: object.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) };
  return { ...object, id, x: object.x + dx, y: object.y + dy, priorBounds: object.priorBounds ? { ...object.priorBounds, x: object.priorBounds.x + dx, y: object.priorBounds.y + dy } : null };
}
async function applyPatches(patches) {
  const document = await readDocument();
  const list = Array.isArray(patches) ? patches : [patches];
  let objects = document.objects, selectedIds = document.selectedIds, viewport = document.viewport;
  for (const patch of list) {
    if (!patch) continue;
    if (patch.op === 'create' && Array.isArray(patch.objects)) {
      const existing = new Set(objects.map((object) => object.id));
      const created = patch.objects
        .map(normalizeCanvasObject)
        .filter((object) => object && object.id && !existing.has(object.id));
      objects = [...objects, ...created];
      if (patch.select) selectedIds = created.map((object) => object.id);
    } else if (patch.op === 'update' && patch.id) {
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
function summarizeDocument(document) {
  const objectCounts = {};
  for (const object of document.objects) objectCounts[object.type] = (objectCounts[object.type] || 0) + 1;
  return { document: { id: document.id, name: document.name, createdAt: document.createdAt, updatedAt: document.updatedAt }, objectCounts, viewport: document.viewport, selectedIds: document.selectedIds, linkedProjects: document.links || [] };
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function ensureDistSync() {
  if (fs.existsSync(path.join(distDir, 'index.html'))) return;
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['run', 'build'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm run build failed with exit code ${result.status}`);
}
function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
  response.end(JSON.stringify(data));
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; if (body.length > 50 * 1024 * 1024) reject(new Error('Request body too large.')); });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
async function serveStatic(request, response) {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  const relativePath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(distDir, relativePath);
  if (!filePath.startsWith(distDir)) { response.writeHead(403); response.end('Forbidden'); return; }
  try {
    const file = await fsp.readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
    response.end(file);
  } catch {
    const index = await fsp.readFile(path.join(distDir, 'index.html'));
    response.writeHead(200, { 'content-type': contentTypes['.html'], 'cache-control': 'no-store' });
    response.end(index);
  }
}
function createAppServer() {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') return sendJson(response, 204, {});
      const url = new URL(request.url || '/', `http://${host}:${port}`);
      if (url.pathname === '/api/health') sendJson(response, 200, { ok: true, documentPath });
      else if (url.pathname === '/api/document' && request.method === 'GET') sendJson(response, 200, await readDocument());
      else if (url.pathname === '/api/document' && request.method === 'POST') sendJson(response, 200, await writeDocument(JSON.parse(await readBody(request))));
      else if (url.pathname === '/api/patch' && request.method === 'POST') sendJson(response, 200, await applyPatches(JSON.parse(await readBody(request))));
      else if (url.pathname === '/api/working' && request.method === 'GET') sendJson(response, 200, { ids: await readWorkingIds() });
      else if (url.pathname === '/api/working' && request.method === 'POST') sendJson(response, 200, { ids: await writeWorkingIds((JSON.parse(await readBody(request))).ids || []) });
      else if (url.pathname === '/api/screenshot-request' && request.method === 'GET') sendJson(response, 200, { request: await readScreenshotRequest() });
      else if (url.pathname === '/api/screenshot-response' && request.method === 'POST') sendJson(response, 200, await writeScreenshotResponse(JSON.parse(await readBody(request))));
      else await serveStatic(request, response);
    } catch (error) { sendJson(response, 500, { error: error.message || String(error) }); }
  });
}
function openBrowser(url) {
  if (process.env.CANVAS_NO_OPEN === '1') return;
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

const GUIDES = {
  'canvas-mcp-instructions': 'Canvas is a live visual collaboration surface. Read before editing, patch incrementally, use stable IDs, request screenshots after meaningful visual changes, and ask before destructive edits.',
  'mermaid-to-canvas': 'Convert Mermaid into native rect, ellipse, text, line, and arrow objects. Do not use static images as the default.',
  'project-preview-workflow': 'Project previews are site frames linked to independent repos. Canvas stores metadata only.',
  'annotation-workflow': 'Treat text, comments, arrows, and strokes with parentId or parentFrameId as annotations.',
};
function toolSchema(name, description, inputSchema = { type: 'object', properties: {} }) { return { name, description, inputSchema }; }
const tools = [
  toolSchema('canvas.get_guide', 'Return Canvas collaboration instructions.', { type: 'object', properties: { topic: { type: 'string' } } }),
  toolSchema('canvas.get_basic_info', 'Return document metadata, counts, viewport, selection, and links.'),
  toolSchema('canvas.get_document', 'Return the full document.'),
  toolSchema('canvas.get_selection', 'Return selected objects.'),
  toolSchema('canvas.get_object_info', 'Return an object and bounds.', { type: 'object', properties: { objectId: { type: 'string' } }, required: ['objectId'] }),
  toolSchema('canvas.get_children', 'Return child objects.', { type: 'object', properties: { objectId: { type: 'string' } }, required: ['objectId'] }),
  toolSchema('canvas.get_tree_summary', 'Return a tree summary.', { type: 'object', properties: { objectId: { type: 'string' }, depth: { type: 'number' } } }),
  toolSchema('canvas.get_annotations', 'Return annotations attached to a target.', { type: 'object', properties: { targetId: { type: 'string' } }, required: ['targetId'] }),
  toolSchema('canvas.get_screenshot', 'Capture a screenshot through the open local Canvas app.', { type: 'object', properties: { target: { type: 'object' }, scale: { type: 'number' }, timeoutMs: { type: 'number' } } }),
  toolSchema('canvas.get_linked_projects', 'Return linked projects.'),
  toolSchema('canvas.create_frame', 'Create a frame.', { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, label: { type: 'string' }, kind: { type: 'string' }, url: { type: 'string' } }, required: ['x', 'y', 'width', 'height'] }),
  toolSchema('canvas.create_objects', 'Create objects.', { type: 'object', properties: { objects: { type: 'array' }, select: { type: 'boolean' } }, required: ['objects'] }),
  toolSchema('canvas.update_objects', 'Patch objects.', { type: 'object', properties: { updates: { type: 'array' } }, required: ['updates'] }),
  toolSchema('canvas.set_text_content', 'Set text content.', { type: 'object', properties: { objectId: { type: 'string' }, text: { type: 'string' } }, required: ['objectId', 'text'] }),
  toolSchema('canvas.move_objects', 'Move objects.', { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, dx: { type: 'number' }, dy: { type: 'number' } }, required: ['ids', 'dx', 'dy'] }),
  toolSchema('canvas.duplicate_objects', 'Duplicate objects.', { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, offset: { type: 'object' } }, required: ['ids'] }),
  toolSchema('canvas.delete_objects', 'Delete objects.', { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] }),
  toolSchema('canvas.rename_objects', 'Rename objects.', { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] }),
  toolSchema('canvas.apply_patch', 'Apply CanvasPatch.', { type: 'object', properties: { patch: {} }, required: ['patch'] }),
  toolSchema('canvas.create_project_preview', 'Create a site preview frame.', { type: 'object', properties: { projectId: { type: 'string' }, url: { type: 'string' }, bounds: { type: 'object' } }, required: ['projectId', 'url'] }),
  toolSchema('canvas.link_project', 'Link a local project.', { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, repoRoot: { type: 'string' }, previewUrl: { type: 'string' } }, required: ['name'] }),
  toolSchema('canvas.unlink_project', 'Unlink a project.', { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] }),
  toolSchema('canvas.set_preview_url', 'Set preview URL.', { type: 'object', properties: { projectId: { type: 'string' }, previewUrl: { type: 'string' } }, required: ['projectId'] }),
  toolSchema('canvas.mark_working', 'Mark working IDs.', { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] }),
  toolSchema('canvas.finish_working', 'Clear working IDs.', { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } }),
];
function resultContent(data) { return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }; }
async function callTool(name, args = {}) {
  const document = await readDocument();
  if (name === 'canvas.get_guide') return resultContent({ topic: args.topic || 'canvas-mcp-instructions', guide: GUIDES[args.topic] || GUIDES['canvas-mcp-instructions'], availableTopics: Object.keys(GUIDES) });
  if (name === 'canvas.get_basic_info') return resultContent({ ...summarizeDocument(document), appUrl: `http://${host}:${port}`, workingIds: await readWorkingIds() });
  if (name === 'canvas.get_document') return resultContent(document);
  if (name === 'canvas.get_selection') return resultContent(document.selectedIds.map((id) => document.objects.find((object) => object.id === id)).filter(Boolean));
  if (name === 'canvas.get_object_info') { const object = document.objects.find((item) => item.id === args.objectId); return resultContent(object ? { object, bounds: objectBounds(object) } : null); }
  if (name === 'canvas.get_children') return resultContent(document.objects.filter((object) => objectParentId(object) === args.objectId));
  if (name === 'canvas.get_tree_summary') {
    const depth = Number.isFinite(args.depth) ? args.depth : 2;
    const roots = args.objectId ? document.objects.filter((object) => object.id === args.objectId) : document.objects.filter((object) => !objectParentId(object));
    const summarize = (object, level) => ({ id: object.id, type: object.type, label: object.type === 'frame' ? object.label : object.type === 'text' || object.type === 'comment' ? String(object.text || '').slice(0, 80) : undefined, bounds: objectBounds(object), children: level < depth ? document.objects.filter((child) => objectParentId(child) === object.id).map((child) => summarize(child, level + 1)) : undefined });
    return resultContent(roots.map((object) => summarize(object, 0)));
  }
  if (name === 'canvas.get_annotations') {
    const target = document.objects.find((object) => object.id === args.targetId);
    return resultContent({ target: target ? { id: target.id, type: target.type, url: target.url } : null, annotations: document.objects.filter((object) => objectParentId(object) === args.targetId && ['text', 'comment', 'arrow', 'stroke'].includes(object.type)).map((object) => object.type === 'arrow' ? { id: object.id, type: 'arrow', from: { x: object.x1, y: object.y1 }, to: { x: object.x2, y: object.y2 } } : object.type === 'stroke' ? { id: object.id, type: 'stroke', bounds: objectBounds(object), points: object.points } : { id: object.id, type: object.type, text: object.text, bounds: objectBounds(object) }) });
  }
  if (name === 'canvas.get_screenshot') {
    const request = {
      id: makeId('screenshot'),
      target: args.target || { type: 'viewport' },
      scale: Number.isFinite(args.scale) ? args.scale : 1,
      createdAt: now(),
    };
    await writeScreenshotRequest(request);
    const response = await waitForScreenshotResponse(request.id, Number.isFinite(args.timeoutMs) ? args.timeoutMs : 12000);
    if (response.error) throw new Error(response.error);
    return resultContent({
      id: response.id,
      target: request.target,
      scale: request.scale,
      capturedAt: response.capturedAt,
      imageData: response.imageData,
    });
  }
  if (name === 'canvas.get_linked_projects') return resultContent(document.links || []);
  if (name === 'canvas.create_frame') {
    const frame = { id: args.id || makeId('frame'), type: 'frame', kind: args.kind || 'plain', x: args.x, y: args.y, width: args.width, height: args.height, label: args.label || 'Frame', background: args.background || (args.kind === 'site' ? '#ffffff' : '#181818'), url: args.url || null, imageData: args.imageData || null, generating: false, priorBounds: null };
    await applyPatches({ op: 'create', objects: [frame], select: true });
    return resultContent(frame);
  }
  if (name === 'canvas.create_objects') {
    const objects = (args.objects || []).map(normalizeCanvasObject).filter(Boolean);
    await applyPatches({ op: 'create', objects, select: args.select !== false });
    return resultContent({ createdIds: objects.map((object) => object.id), objects });
  }
  if (name === 'canvas.update_objects') { await applyPatches(args.updates.map((item) => ({ op: 'update', id: item.id, changes: item.changes }))); return resultContent({ updatedIds: args.updates.map((item) => item.id) }); }
  if (name === 'canvas.set_text_content') { await applyPatches({ op: 'update', id: args.objectId, changes: { text: args.text } }); return resultContent({ id: args.objectId, text: args.text }); }
  if (name === 'canvas.move_objects') { const patches = document.objects.filter((object) => args.ids.includes(object.id)).map((object) => ({ op: 'update', id: object.id, changes: shiftObject(object, args.dx, args.dy) })); await applyPatches(patches); return resultContent({ movedIds: patches.map((patch) => patch.id), dx: args.dx, dy: args.dy }); }
  if (name === 'canvas.duplicate_objects') { const offset = args.offset || { x: 24, y: 24 }; const clones = document.objects.filter((object) => args.ids.includes(object.id)).map((object) => shiftObject(object, offset.x || 24, offset.y || 24, makeId(object.type))); await applyPatches({ op: 'create', objects: clones, select: true }); return resultContent({ createdIds: clones.map((object) => object.id) }); }
  if (name === 'canvas.delete_objects') { await applyPatches({ op: 'delete', ids: args.ids }); return resultContent({ deletedIds: args.ids }); }
  if (name === 'canvas.rename_objects') { await applyPatches(args.items.map((item) => ({ op: 'update', id: item.id, changes: { label: item.name } }))); return resultContent({ renamedIds: args.items.map((item) => item.id) }); }
  if (name === 'canvas.apply_patch') { await applyPatches(args.patch); return resultContent({ ok: true }); }
  if (name === 'canvas.create_project_preview') {
    const link = (document.links || []).find((item) => item.id === args.projectId);
    const bounds = args.bounds || { x: 0, y: 0, width: 1024, height: 768 };
    const frame = { id: makeId('frame'), type: 'frame', kind: 'site', x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, label: link?.name ? `${link.name} preview` : 'Project preview', background: '#ffffff', url: args.url, imageData: null, generating: false, priorBounds: null };
    await writeDocument({ ...document, objects: [...document.objects, frame], selectedIds: [frame.id], links: (document.links || []).map((item) => item.id === args.projectId ? { ...item, previewUrl: args.url } : item), updatedAt: now() });
    return resultContent(frame);
  }
  if (name === 'canvas.link_project') { const link = { id: args.id || makeId('proj'), kind: 'local-project', name: args.name, path: args.path, repoRoot: args.repoRoot, previewUrl: args.previewUrl, createdAt: now() }; await writeDocument({ ...document, links: [...(document.links || []).filter((item) => item.id !== link.id), link], updatedAt: now() }); return resultContent(link); }
  if (name === 'canvas.unlink_project') { await writeDocument({ ...document, links: (document.links || []).filter((link) => link.id !== args.projectId), updatedAt: now() }); return resultContent({ unlinkedId: args.projectId }); }
  if (name === 'canvas.set_preview_url') { await writeDocument({ ...document, links: (document.links || []).map((link) => link.id === args.projectId ? { ...link, previewUrl: args.previewUrl } : link), updatedAt: now() }); return resultContent({ projectId: args.projectId, previewUrl: args.previewUrl }); }
  if (name === 'canvas.mark_working') { const ids = Array.from(new Set([...(await readWorkingIds()), ...(args.ids || [])])); await writeWorkingIds(ids); return resultContent({ workingIds: ids }); }
  if (name === 'canvas.finish_working') { const ids = Array.isArray(args.ids) ? (await readWorkingIds()).filter((id) => !args.ids.includes(id)) : []; await writeWorkingIds(ids); return resultContent({ workingIds: ids }); }
  throw new Error(`Unknown tool: ${name}`);
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
async function handle(message) {
  const { id, method, params } = message || {};
  try {
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'canvas-local', version: '0.1.0' } } });
    else if (method === 'notifications/initialized') return;
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments || {}) });
    else send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message || String(error) } }); }
}

if (process.env.CANVAS_MODE === 'mcp') {
  ensureDistSync();
  const server = createAppServer();
  const url = `http://${host}:${port}`;
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    openBrowser(url);
  });
  server.listen(port, host, () => {
    openBrowser(url);
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      try { await handle(JSON.parse(line)); }
      catch (error) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message || String(error) } }); }
    });
  });
  rl.on('close', () => {
    queue.finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 100);
    });
  });
} else {
  ensureDistSync();
  const server = createAppServer();
  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`Canvas local app: ${url}`);
    console.log(`Document: ${documentPath}`);
    openBrowser(url);
  });
}
