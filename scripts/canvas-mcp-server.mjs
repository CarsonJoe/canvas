#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyPatches,
  appendChange,
  appHost,
  appPort,
  appUrl,
  documentPath,
  helperVersion,
  makeId,
  now,
  normalizeCanvasObject,
  objectBounds,
  objectParentId,
  readDocument,
  setAppPort,
  shiftObject,
  waitForScreenshotResponse,
  writeAssetSource,
  writeScreenshotRequest,
} from './canvas-local-core.mjs';

const CONTENT_KINDS = ['html', 'markdown', 'mermaid', 'svg'];

const CANVAS_GUIDE = `# Canvas MCP Usage Guide

## Object Schemas

### frame
{ type:"frame", x, y, width, height, label, kind:"plain"|"site"|"html"|"markdown"|"mermaid"|"svg",
  url (required for kind "site"; auto-set for html/markdown/mermaid/svg when source is provided),
  source (string content for html/markdown/mermaid/svg kinds),
  background }

### rect
{ type:"rect", x, y, width, height, fill, stroke, strokeWidth, cornerRadius }

### ellipse
Position is the CENTER point, not top-left.
{ type:"ellipse", x, y, radiusX, radiusY, fill, stroke, strokeWidth }
Bounds = { x: x-radiusX, y: y-radiusY, width: radiusX*2, height: radiusY*2 }

### text
{ type:"text", x, y, text, fontSize, color, fontFamily, parentFrameId? }

### comment
{ type:"comment", x, y, text, parentFrameId? }

### line
{ type:"line", x1, y1, x2, y2, stroke, strokeWidth }

### arrow
{ type:"arrow", x1, y1, x2, y2, stroke, strokeWidth, cx?, cy? }
cx/cy are an optional curve control point.

### stroke (freehand)
{ type:"stroke", points:[x0,y0,x1,y1,...] }
points is a FLAT alternating x,y number array, NOT an array of [x,y] pairs.

---

## canvas.create_objects
- objects: array of plain object definitions — each must be a JS object with a type field, NOT a JSON string.
- Objects are automatically assigned an id if you omit one.

## canvas.update_objects
- updates: [{ id:"object-id", changes:{ ...fieldsToChange } }, ...]
- Only the fields in changes are merged; other fields are preserved.
- Passing an item without changes or with a null id produces updatedIds:[null] and changes nothing.
- Example: [{ id:"frame_abc123", changes:{ label:"New title", x:200 } }]

## canvas.apply_patch
- patch: a single operation OR an array of operations.
- Unknown op values are silently ignored and return { ok:true } — validate your op field.

Supported ops:
  { op:"create",   objects:[...], select:true|false }
  { op:"update",   id:"object-id", changes:{...} }
  { op:"delete",   ids:["id1","id2"] }
  { op:"select",   ids:["id1"] }
  { op:"viewport", x:number, y:number, scale:number }

WRONG shapes that silently do nothing:
  { ops:[...] }       ← wrong key (should be op, not ops)
  [{"op":"add",...}]  ← JSON Patch style — not supported
  { create:[...] }    ← missing op key

---

## canvas.get_screenshot
target is required to have a type field — passing raw coordinates without it throws "Screenshot target not found."
  { type: "viewport" }                              — capture what's visible (default)
  { type: "bounds", x, y, width, height }           — canvas coordinate region
  { type: "object", objectId: "frame_abc" }         — bounding box of one object
  { type: "selection" }                             — bounding box of current selection

---

## Workspace URL
All tool calls read/write this workspace's .canvas/canvas.json.
The app URL for this workspace is embedded in every tool response as view_url.
If view_url differs from what you expect, call canvas.get_document to confirm
which document is active.
`;

async function probeCanvasHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return await response.json();
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function resolveAppPort() {
  const health = await probeCanvasHealth(appUrl);
  if (!health) return; // Port is free — bind normally

  if (health.documentPath === documentPath) return; // Same workspace on this port — reuse it

  // A different workspace owns our preferred port. Find a free port or a port already
  // serving this workspace.
  process.stderr.write(
    `[canvas] Port ${appPort} is in use by a different workspace (${health.documentPath}).\n` +
    `[canvas] Scanning for a free port...\n`,
  );
  const base = appPort;
  for (let p = base + 1; p <= base + 50; p++) {
    const h = await probeCanvasHealth(`http://${appHost}:${p}`);
    if (h?.documentPath === documentPath) {
      // Found an existing server for this workspace on a different port
      process.stderr.write(`[canvas] Found existing server for this workspace on port ${p}.\n`);
      setAppPort(p);
      return;
    }
    if (!h) {
      process.stderr.write(`[canvas] Using port ${p} for this workspace.\n`);
      setAppPort(p);
      return;
    }
  }
  process.stderr.write(
    `[canvas] Warning: Could not find a free port in range ${base + 1}–${base + 50}.\n` +
    `[canvas] The browser may show a different workspace than the MCP is editing.\n`,
  );
}

function toolSchema(name, description, inputSchema = { type: 'object', properties: {} }) {
  return { name, description, inputSchema };
}

export const tools = [
  toolSchema('canvas.get_guide', 'Return the Canvas MCP usage guide: all object schemas, patch operation shapes, and examples. Call this first if you are unsure about expected data shapes.'),
  toolSchema('canvas.get_document', 'Return the full current Canvas document, including objects, selectedIds, and viewport. Read this before making edits.'),
  toolSchema('canvas.get_object_info', 'Return one object and its bounds.', {
    type: 'object',
    properties: { objectId: { type: 'string' } },
    required: ['objectId'],
  }),
  toolSchema('canvas.get_children', 'Return objects attached to an object through parentId or parentFrameId. Text, comments, arrows, and strokes attached this way are annotations.', {
    type: 'object',
    properties: { objectId: { type: 'string' } },
    required: ['objectId'],
  }),
  toolSchema('canvas.get_tree_summary', 'Return a shallow object tree summary.', {
    type: 'object',
    properties: { objectId: { type: 'string' }, depth: { type: 'number' } },
  }),
  toolSchema('canvas.get_screenshot', 'Capture a screenshot through the open local Canvas app. target shapes: { type:"viewport" } (default), { type:"bounds", x, y, width, height } (canvas coordinates), { type:"object", objectId:"..." }, { type:"selection" }.', {
    type: 'object',
    properties: { target: { type: 'object' }, scale: { type: 'number' }, timeoutMs: { type: 'number' } },
  }),
  toolSchema('canvas.create_objects', 'Create native canvas objects. objects must be an array of plain object definitions (not strings), each with a type field. Supported types: frame, rect, ellipse, text, comment, line, arrow, stroke. For site previews use frame with kind "site" and url. For rich content use frame with kind "html", "markdown", "mermaid", or "svg" and set source to the content string. Call canvas.get_guide for full schema reference.', {
    type: 'object',
    properties: { objects: { type: 'array', items: { type: 'object' } }, select: { type: 'boolean' } },
    required: ['objects'],
  }),
  toolSchema('canvas.update_objects', 'Patch existing objects by ID. Each entry in updates must be { id: "object-id", changes: { ...fieldsToUpdate } }. Example: [{ id: "frame_abc", changes: { label: "New label", x: 100 } }]. Do NOT pass the whole object — only the fields that should change.', {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, changes: { type: 'object' } },
          required: ['id', 'changes'],
        },
      },
    },
    required: ['updates'],
  }),
  toolSchema('canvas.duplicate_objects', 'Duplicate objects with an offset.', {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } }, offset: { type: 'object' } },
    required: ['ids'],
  }),
  toolSchema('canvas.delete_objects', 'Delete objects by ID.', {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
    required: ['ids'],
  }),
  toolSchema('canvas.apply_patch', 'Apply one or more CanvasPatch operations. patch can be a single operation object or an array of operations. Each operation must have an op field. Supported ops: { op: "create", objects: [...], select: bool } — creates objects; { op: "update", id: "object-id", changes: {...} } — merges changes into one object; { op: "delete", ids: [...] } — removes objects; { op: "select", ids: [...] } — sets selection; { op: "viewport", x, y, scale } — moves the viewport. Wrong op shapes are silently ignored.', {
    type: 'object',
    properties: { patch: {} },
    required: ['patch'],
  }),
  toolSchema('canvas.launch', 'Open the Canvas app in the default browser so the user can view your work. Call this when you want the user to see the canvas. Pass focusObjectId to center the view on a specific object.', {
    type: 'object',
    properties: { focusObjectId: { type: 'string' } },
  }),
];

export function content(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export async function callTool(name, args = {}, context = {}) {
  const document = await readDocument();
  const transport = context.transport ?? 'stdio';

  switch (name) {
    case 'canvas.get_guide':
      return content(CANVAS_GUIDE);
    case 'canvas.get_document':
      return content({ ...document, appUrl, transport });
    case 'canvas.get_object_info': {
      const object = document.objects.find((item) => item.id === args.objectId);
      return content(object ? { object, bounds: objectBounds(object) } : null);
    }
    case 'canvas.get_children':
      return content(document.objects.filter((object) => objectParentId(object) === args.objectId));
    case 'canvas.get_tree_summary': {
      const depth = Number.isFinite(args.depth) ? args.depth : 2;
      const roots = args.objectId
        ? document.objects.filter((object) => object.id === args.objectId)
        : document.objects.filter((object) => !objectParentId(object));
      const summarize = (object, level) => ({
        id: object.id,
        type: object.type,
        label: object.type === 'frame' ? object.label : object.type === 'text' || object.type === 'comment' ? String(object.text ?? '').slice(0, 80) : undefined,
        bounds: objectBounds(object),
        children: level < depth
          ? document.objects.filter((child) => objectParentId(child) === object.id).map((child) => summarize(child, level + 1))
          : undefined,
      });
      return content(roots.map((object) => summarize(object, 0)));
    }
    case 'canvas.get_screenshot':
      {
        const request = {
          id: makeId('screenshot'),
          target: args.target ?? { type: 'viewport' },
          scale: Number.isFinite(args.scale) ? args.scale : 1,
          createdAt: now(),
        };
        await writeScreenshotRequest(request);
        const response = await waitForScreenshotResponse(request.id, Number.isFinite(args.timeoutMs) ? args.timeoutMs : 12000);
        if (response.error) throw new Error(response.error);
        return content({
          id: response.id,
          target: request.target,
          scale: request.scale,
          capturedAt: response.capturedAt,
          imageData: response.imageData,
        });
      }
    case 'canvas.launch': {
      const focusId = args.focusObjectId ?? null;
      if (process.env.CANVAS_NO_OPEN !== '1') {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', appUrl] : [appUrl];
        const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
        child.unref();
      }
      if (focusId) {
        await appendChange({ author: 'llm', op: 'launch', objectIds: [focusId], focusId }).catch(() => {});
      }
      return content({ app_url: appUrl, opened: process.env.CANVAS_NO_OPEN !== '1', focusObjectId: focusId });
    }
    case 'canvas.create_objects': {
      const objects = (args.objects ?? []).map(normalizeCanvasObject).filter(Boolean);
      const assets = [];
      for (const obj of objects) {
        if (obj.type === 'frame' && CONTENT_KINDS.includes(obj.kind) && obj.source && !obj.flatten) {
          const format = obj.kind === 'html' ? 'html' : obj.kind === 'svg' ? 'svg' : 'markdown';
          const filePath = await writeAssetSource(obj.id, obj.source, format);
          const ext = format === 'html' ? 'html' : format === 'svg' ? 'svg' : 'md';
          obj.url = `${appUrl}/assets/${obj.id}`;
          assets.push({ id: obj.id, url: obj.url, edit_file: `.canvas/assets/${obj.id}.${ext}`, filePath });
        }
      }
      await applyPatches({ op: 'create', objects, select: args.select ?? true });
      await appendChange({ author: 'llm', op: 'create_objects', objectIds: objects.map((o) => o.id), focusId: objects[0]?.id ?? null }).catch(() => {});
      return content({ createdIds: objects.map((o) => o.id), objects, view_url: appUrl, ...(assets.length ? { assets } : {}) });
    }
    case 'canvas.update_objects':
      await applyPatches(args.updates.map((item) => ({ op: 'update', id: item.id, changes: item.changes })));
      await appendChange({ author: 'llm', op: 'update_objects', objectIds: args.updates.map((item) => item.id), focusId: args.updates[0]?.id ?? null }).catch(() => {});
      return content({ updatedIds: args.updates.map((item) => item.id), view_url: appUrl });
    case 'canvas.duplicate_objects': {
      const offset = args.offset ?? { x: 24, y: 24 };
      const clones = document.objects
        .filter((object) => args.ids.includes(object.id))
        .map((object) => shiftObject(object, offset.x ?? 24, offset.y ?? 24, makeId(object.type)));
      await applyPatches({ op: 'create', objects: clones, select: true });
      await appendChange({ author: 'llm', op: 'duplicate_objects', objectIds: clones.map((o) => o.id), focusId: clones[0]?.id ?? null }).catch(() => {});
      return content({ createdIds: clones.map((object) => object.id), view_url: appUrl });
    }
    case 'canvas.delete_objects':
      await applyPatches({ op: 'delete', ids: args.ids });
      await appendChange({ author: 'llm', op: 'delete_objects', objectIds: args.ids, focusId: null }).catch(() => {});
      return content({ deletedIds: args.ids, view_url: appUrl });
    case 'canvas.apply_patch':
      await applyPatches(args.patch);
      await appendChange({ author: 'llm', op: 'apply_patch', objectIds: [], focusId: null }).catch(() => {});
      return content({ ok: true, view_url: appUrl });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function handleMcpMessage(message, context = {}) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cogniboom-canvas', version: helperVersion },
        },
      };
    } else if (method === 'notifications/initialized') {
      return;
    } else if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    } else if (method === 'tools/call') {
      return { jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments ?? {}, context) };
    } else {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function handleStdioMessage(message) {
  const response = await handleMcpMessage(message, { transport: 'stdio' });
  if (response) send(response);
}

export async function startStdioMcpServer({ startApp = true, open = true } = {}) {
  if (startApp) await resolveAppPort();

  const appServerModule = startApp ? await import('./canvas-app-server.mjs') : null;
  const server = appServerModule ? appServerModule.createCanvasAppServer() : null;
  if (server) {
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        // Port was free during resolveAppPort but got taken before bind (race condition).
        process.stderr.write(
          `[canvas] Error: port ${appPort} was taken by the time we tried to bind.\n` +
          `[canvas] The MCP server will continue but the browser app could not be started.\n` +
          `[canvas] Stop other Canvas servers and restart this MCP server.\n`,
        );
        return;
      }
      throw error;
    });
    server.listen(new URL(appUrl).port, new URL(appUrl).hostname, () => {
      if (open) appServerModule.openBrowser(appUrl);
    });
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      try {
        await handleStdioMessage(JSON.parse(line));
      } catch (error) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
      }
    });
  });
  rl.on('close', () => {
    queue.finally(() => {
      if (!server) {
        process.exit(0);
        return;
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 100);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioMcpServer();
}
