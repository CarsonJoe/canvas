#!/usr/bin/env node
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyPatches,
  appUrl,
  appVersion,
  helperVersion,
  documentPath,
  makeId,
  mcpHttpUrl,
  now,
  normalizeCanvasObject,
  objectBounds,
  objectParentId,
  readWorkingIds,
  readDocument,
  shiftObject,
  summarizeDocument,
  waitForScreenshotResponse,
  writeDocument,
  writeScreenshotRequest,
  writeWorkingIds,
} from './canvas-local-core.mjs';

const GUIDES = {
  'canvas-mcp-instructions': [
    'Canvas is a live visual collaboration surface. Read the document and selection before editing.',
    'Prefer incremental object patches over replacing the whole scene.',
    'Use stable object IDs returned by read tools. Name frames and major objects clearly.',
    'After meaningful visual changes, call get_screenshot or inspect the open app before continuing.',
    'Ask before destructive changes that delete many objects or unlink projects.',
    'Use mark_working and finish_working while editing visible objects or regions.',
  ].join('\n'),
  'mermaid-to-canvas': [
    'Convert Mermaid to native editable canvas objects.',
    'Use rect, ellipse, text, line, and arrow objects rather than static images.',
    'Keep layout readable and create diagrams incrementally.',
  ].join('\n'),
  'project-preview-workflow': [
    'Project previews are site frames linked to independent repos.',
    'Canvas stores project paths and preview URLs only.',
    'Use annotations on the preview frame as guidance for code edits outside Canvas.',
  ].join('\n'),
  'annotation-workflow': [
    'Treat text, comments, arrows, and strokes with parentId or parentFrameId as annotations.',
    'Interpret annotation text as intent and arrows/strokes as spatial guidance.',
  ].join('\n'),
};

let workingIds = new Set();

function toolSchema(name, description, inputSchema = { type: 'object', properties: {} }) {
  return { name, description, inputSchema };
}

export const tools = [
  toolSchema('canvas.get_guide', 'Return Canvas collaboration instructions for a topic.', {
    type: 'object',
    properties: { topic: { type: 'string' } },
  }),
  toolSchema('canvas.get_basic_info', 'Return document metadata, object counts, viewport, selection, and linked projects.'),
  toolSchema('canvas.get_document', 'Return the full current Canvas document.'),
  toolSchema('canvas.get_selection', 'Return currently selected objects.'),
  toolSchema('canvas.get_object_info', 'Return one object and its bounds.', {
    type: 'object',
    properties: { objectId: { type: 'string' } },
    required: ['objectId'],
  }),
  toolSchema('canvas.get_children', 'Return child objects attached to an object.', {
    type: 'object',
    properties: { objectId: { type: 'string' } },
    required: ['objectId'],
  }),
  toolSchema('canvas.get_tree_summary', 'Return a shallow object tree summary.', {
    type: 'object',
    properties: { objectId: { type: 'string' }, depth: { type: 'number' } },
  }),
  toolSchema('canvas.get_annotations', 'Return normalized annotations attached to a target object.', {
    type: 'object',
    properties: { targetId: { type: 'string' } },
    required: ['targetId'],
  }),
  toolSchema('canvas.get_screenshot', 'Capture a screenshot through the open local Canvas app.', {
    type: 'object',
    properties: { target: { type: 'object' }, scale: { type: 'number' }, timeoutMs: { type: 'number' } },
  }),
  toolSchema('canvas.get_linked_projects', 'Return linked project metadata.'),
  toolSchema('canvas.create_frame', 'Create a plain/image/site frame.', {
    type: 'object',
    properties: {
      x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
      label: { type: 'string' }, kind: { type: 'string' }, background: { type: 'string' }, url: { type: 'string' },
    },
    required: ['x', 'y', 'width', 'height'],
  }),
  toolSchema('canvas.create_objects', 'Create native canvas objects.', {
    type: 'object',
    properties: { objects: { type: 'array' }, select: { type: 'boolean' } },
    required: ['objects'],
  }),
  toolSchema('canvas.update_objects', 'Patch existing objects by ID.', {
    type: 'object',
    properties: { updates: { type: 'array' } },
    required: ['updates'],
  }),
  toolSchema('canvas.set_text_content', 'Set text on a text or comment object.', {
    type: 'object',
    properties: { objectId: { type: 'string' }, text: { type: 'string' } },
    required: ['objectId', 'text'],
  }),
  toolSchema('canvas.move_objects', 'Move objects by delta.', {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } }, dx: { type: 'number' }, dy: { type: 'number' } },
    required: ['ids', 'dx', 'dy'],
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
  toolSchema('canvas.rename_objects', 'Rename frame-like objects by changing labels.', {
    type: 'object',
    properties: { items: { type: 'array' } },
    required: ['items'],
  }),
  toolSchema('canvas.apply_patch', 'Apply CanvasPatch operations.', {
    type: 'object',
    properties: { patch: {} },
    required: ['patch'],
  }),
  toolSchema('canvas.create_project_preview', 'Create a site preview frame linked to a project.', {
    type: 'object',
    properties: { projectId: { type: 'string' }, url: { type: 'string' }, bounds: { type: 'object' } },
    required: ['projectId', 'url'],
  }),
  toolSchema('canvas.link_project', 'Link an independent local project.', {
    type: 'object',
    properties: { name: { type: 'string' }, path: { type: 'string' }, repoRoot: { type: 'string' }, previewUrl: { type: 'string' } },
    required: ['name'],
  }),
  toolSchema('canvas.unlink_project', 'Unlink a project by ID.', {
    type: 'object',
    properties: { projectId: { type: 'string' } },
    required: ['projectId'],
  }),
  toolSchema('canvas.set_preview_url', 'Set a linked project preview URL.', {
    type: 'object',
    properties: { projectId: { type: 'string' }, previewUrl: { type: 'string' } },
    required: ['projectId'],
  }),
  toolSchema('canvas.mark_working', 'Mark objects as being edited by the agent.', {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
    required: ['ids'],
  }),
  toolSchema('canvas.finish_working', 'Clear working indicators.', {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
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
      return content({
        topic: args.topic ?? 'canvas-mcp-instructions',
        guide: GUIDES[args.topic] ?? GUIDES['canvas-mcp-instructions'],
        availableTopics: Object.keys(GUIDES),
      });
    case 'canvas.get_basic_info':
      workingIds = new Set(await readWorkingIds());
      return content({
        ...summarizeDocument(document),
        appUrl,
        mcpHttpUrl,
        helperVersion,
        appVersion,
        transport,
        documentPath,
        screenshotBridge: 'waiting',
        workingIds: [...workingIds],
      });
    case 'canvas.get_document':
      return content(document);
    case 'canvas.get_selection':
      return content(document.selectedIds.map((id) => document.objects.find((object) => object.id === id)).filter(Boolean));
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
    case 'canvas.get_annotations': {
      const target = document.objects.find((object) => object.id === args.targetId);
      const annotations = document.objects
        .filter((object) => objectParentId(object) === args.targetId)
        .filter((object) => ['text', 'comment', 'arrow', 'stroke'].includes(object.type))
        .map((object) => {
          if (object.type === 'text' || object.type === 'comment') return { id: object.id, type: object.type, text: object.text, bounds: objectBounds(object) };
          if (object.type === 'arrow') return { id: object.id, type: 'arrow', from: { x: object.x1, y: object.y1 }, to: { x: object.x2, y: object.y2 } };
          return { id: object.id, type: 'stroke', bounds: objectBounds(object), points: object.points };
        });
      return content({ target: target ? { id: target.id, type: target.type, url: target.url } : null, annotations });
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
    case 'canvas.get_linked_projects':
      return content(document.links ?? []);
    case 'canvas.create_frame': {
      const frame = {
        id: args.id ?? makeId('frame'),
        type: 'frame',
        kind: args.kind ?? 'plain',
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        label: args.label ?? 'Frame',
        background: args.background ?? (args.kind === 'site' ? '#ffffff' : '#181818'),
        url: args.url ?? null,
        imageData: args.imageData ?? null,
        generating: false,
        priorBounds: null,
      };
      await applyPatches({ op: 'create', objects: [frame], select: true });
      return content(frame);
    }
    case 'canvas.create_objects':
      {
        const objects = (args.objects ?? []).map(normalizeCanvasObject).filter(Boolean);
        await applyPatches({ op: 'create', objects, select: args.select ?? true });
        return content({ createdIds: objects.map((object) => object.id), objects });
      }
    case 'canvas.update_objects':
      await applyPatches(args.updates.map((item) => ({ op: 'update', id: item.id, changes: item.changes })));
      return content({ updatedIds: args.updates.map((item) => item.id) });
    case 'canvas.set_text_content':
      await applyPatches({ op: 'update', id: args.objectId, changes: { text: args.text } });
      return content({ id: args.objectId, text: args.text });
    case 'canvas.move_objects': {
      const patches = document.objects
        .filter((object) => args.ids.includes(object.id))
        .map((object) => ({ op: 'update', id: object.id, changes: shiftObject(object, args.dx, args.dy) }));
      await applyPatches(patches);
      return content({ movedIds: patches.map((patch) => patch.id), dx: args.dx, dy: args.dy });
    }
    case 'canvas.duplicate_objects': {
      const offset = args.offset ?? { x: 24, y: 24 };
      const clones = document.objects
        .filter((object) => args.ids.includes(object.id))
        .map((object) => shiftObject(object, offset.x ?? 24, offset.y ?? 24, makeId(object.type)));
      await applyPatches({ op: 'create', objects: clones, select: true });
      return content({ createdIds: clones.map((object) => object.id) });
    }
    case 'canvas.delete_objects':
      await applyPatches({ op: 'delete', ids: args.ids });
      return content({ deletedIds: args.ids });
    case 'canvas.rename_objects':
      await applyPatches(args.items.map((item) => ({ op: 'update', id: item.id, changes: { label: item.name } })));
      return content({ renamedIds: args.items.map((item) => item.id) });
    case 'canvas.apply_patch':
      await applyPatches(args.patch);
      return content({ ok: true });
    case 'canvas.create_project_preview': {
      const link = document.links?.find((item) => item.id === args.projectId);
      const bounds = args.bounds ?? { x: 0, y: 0, width: 1024, height: 768 };
      const frame = {
        id: makeId('frame'),
        type: 'frame',
        kind: 'site',
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        label: link?.name ? `${link.name} preview` : 'Project preview',
        background: '#ffffff',
        url: args.url,
        imageData: null,
        generating: false,
        priorBounds: null,
      };
      const links = (document.links ?? []).map((item) => item.id === args.projectId ? { ...item, previewUrl: args.url } : item);
      await writeDocument({ ...document, objects: [...document.objects, frame], selectedIds: [frame.id], links, updatedAt: now() });
      return content(frame);
    }
    case 'canvas.link_project': {
      const link = {
        id: args.id ?? makeId('proj'),
        kind: 'local-project',
        name: args.name,
        path: args.path,
        repoRoot: args.repoRoot,
        previewUrl: args.previewUrl,
        createdAt: now(),
      };
      await writeDocument({ ...document, links: [...(document.links ?? []).filter((item) => item.id !== link.id), link], updatedAt: now() });
      return content(link);
    }
    case 'canvas.unlink_project':
      await writeDocument({ ...document, links: (document.links ?? []).filter((link) => link.id !== args.projectId), updatedAt: now() });
      return content({ unlinkedId: args.projectId });
    case 'canvas.set_preview_url':
      await writeDocument({
        ...document,
        links: (document.links ?? []).map((link) => link.id === args.projectId ? { ...link, previewUrl: args.previewUrl } : link),
        updatedAt: now(),
      });
      return content({ projectId: args.projectId, previewUrl: args.previewUrl });
    case 'canvas.mark_working':
      workingIds = new Set(await readWorkingIds());
      for (const id of args.ids ?? []) workingIds.add(id);
      await writeWorkingIds([...workingIds]);
      return content({ workingIds: [...workingIds] });
    case 'canvas.finish_working':
      workingIds = new Set(await readWorkingIds());
      if (Array.isArray(args.ids)) {
        for (const id of args.ids) workingIds.delete(id);
      } else {
        workingIds.clear();
      }
      await writeWorkingIds([...workingIds]);
      return content({ workingIds: [...workingIds] });
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
