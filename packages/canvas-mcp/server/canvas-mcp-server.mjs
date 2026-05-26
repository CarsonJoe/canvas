#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyPatches,
  appendChange,
  appUrl,
  helperVersion,
  makeId,
  now,
  normalizeCanvasObject,
  objectBounds,
  objectParentId,
  readDocument,
  shiftObject,
  waitForScreenshotResponse,
  writeAssetSource,
  writeScreenshotRequest,
} from './canvas-local-core.mjs';

const CONTENT_KINDS = ['html', 'markdown', 'mermaid', 'svg'];

function toolSchema(name, description, inputSchema = { type: 'object', properties: {} }) {
  return { name, description, inputSchema };
}

export const tools = [
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
  toolSchema('canvas.get_screenshot', 'Capture a screenshot through the open local Canvas app.', {
    type: 'object',
    properties: { target: { type: 'object' }, scale: { type: 'number' }, timeoutMs: { type: 'number' } },
  }),
  toolSchema('canvas.create_objects', 'Create native canvas objects. Use frame objects with kind "site" and url for previews. For rich content use frame objects with kind "html", "markdown", "mermaid", or "svg"; when source is provided and flatten is false or omitted, the source is written to .canvas/assets and the frame url is set automatically.', {
    type: 'object',
    properties: { objects: { type: 'array' }, select: { type: 'boolean' } },
    required: ['objects'],
  }),
  toolSchema('canvas.update_objects', 'Patch existing objects by ID. Use this for text edits, moves, renames, style changes, frame URL changes, and other partial object updates.', {
    type: 'object',
    properties: { updates: { type: 'array' } },
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
  toolSchema('canvas.apply_patch', 'Apply CanvasPatch operations for batch create, update, delete, selection, or viewport changes.', {
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
  const appServerModule = startApp ? await import('./canvas-app-server.mjs') : null;
  const server = appServerModule ? appServerModule.createCanvasAppServer() : null;
  if (server) {
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        if (open) appServerModule.openBrowser(appUrl);
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
