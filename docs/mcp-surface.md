# MCP Surface

This document describes the MCP-facing surface of Cogniboom Canvas. The intended model is small: an agent reads one canvas document, creates objects, patches objects, deletes objects, and asks the browser for screenshots.

## Entry Points

The source implementation lives in `scripts/`:

- `scripts/canvas-mcp-server.mjs` defines the MCP protocol handler, tool schemas, and tool implementations.
- `scripts/canvas-app-server.mjs` serves the local Canvas app, HTTP MCP endpoint, and bridge REST endpoints.
- `scripts/canvas-local-core.mjs` owns local persistence, document normalization, patch application, screenshot request/response files, and change logging.

The published helper package mirrors those files under `packages/canvas-mcp/server/`. `scripts/prepare-canvas-mcp-package.mjs` copies the source server files into the package during `npm run build:mcp-package`.

The package CLI is `packages/canvas-mcp/bin/canvas-mcp.js`, exposed as the `canvas` binary.

## Transports

Canvas exposes one MCP server over two transports.

### Stdio

`canvas serve`

- Starts the local Canvas app server unless one is already using the configured port.
- Reads newline-delimited JSON-RPC messages from stdin.
- Writes JSON-RPC responses to stdout.
- Uses `handleMcpMessage(message, { transport: 'stdio' })`.

### HTTP

`canvas http`

- Starts the local Canvas app server.
- Exposes MCP at `http://127.0.0.1:3762/mcp` by default.
- `GET /mcp` returns a small health-style payload.
- `POST /mcp` accepts a single JSON-RPC message or a JSON-RPC batch.
- Uses `handleMcpMessage(message, { transport: 'http' })`.

Set `CANVAS_PORT` to move both the app and HTTP MCP endpoint to another port.

## Protocol Methods

The server implements a minimal JSON-RPC MCP surface:

- `initialize` returns protocol version `2024-11-05`, tool capability metadata, and server info `{ name: 'cogniboom-canvas', version: helperVersion }`.
- `notifications/initialized` is accepted and produces no response.
- `tools/list` returns all tool schemas.
- `tools/call` dispatches to the named Canvas tool.

Unknown methods return JSON-RPC `-32601`. Tool errors return JSON-RPC `-32000`.

## Tools

Tool names are exposed with the `canvas.` prefix in MCP.

| Tool | Purpose |
| --- | --- |
| `canvas.get_document` | Returns the full current document, including objects, selected IDs, and viewport. Agents should read this before editing. |
| `canvas.get_object_info` | Returns one object plus calculated bounds. Requires `objectId`. |
| `canvas.get_children` | Returns objects attached through `parentId` or `parentFrameId`. Attached text, comments, arrows, and strokes are annotations. |
| `canvas.get_tree_summary` | Returns a shallow object tree rooted at `objectId`, or all root objects when omitted. Accepts optional `depth`, default `2`. |
| `canvas.get_screenshot` | Requests a browser-captured screenshot and waits for the local app to respond. |
| `canvas.create_objects` | Creates native canvas objects. Use frame objects for plain frames, images, site previews, and rich content assets. |
| `canvas.update_objects` | Applies partial updates by object ID. Use this for text edits, moves, renames, style changes, frame URL changes, and other object changes. |
| `canvas.duplicate_objects` | Clones objects with an offset. Required: `ids`. Optional: `offset`, default `{ x: 24, y: 24 }`. |
| `canvas.delete_objects` | Deletes objects by ID. Required: `ids`. |
| `canvas.apply_patch` | Applies one `CanvasPatch` or an array of patches for batch create, update, delete, selection, or viewport changes. |
| `canvas.launch` | Opens the local Canvas app in the default browser unless `CANVAS_NO_OPEN=1`. Optional: `focusObjectId`. |

There are no separate workflow-discovery tools. The object model carries the workflow:

- A preview is a frame with `kind: "site"` and a `url`.
- An annotation is a normal text, comment, arrow, or stroke object attached to another object with `parentId` or `parentFrameId`.
- Moving, renaming, editing text, and changing a preview URL are all `update_objects`.
- Batch edits are `apply_patch`.

## Object Contract

Canvas documents use this top-level shape:

```ts
interface CanvasDocument {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  objects: CanvasObject[];
  selectedIds: string[];
  viewport: { x: number; y: number; scale: number };
}
```

Supported object types:

- `frame`
- `rect`
- `ellipse`
- `line`
- `arrow`
- `text`
- `comment`
- `stroke`

Frames support these `kind` values:

- `plain`
- `image`
- `site`
- `html`
- `markdown`
- `mermaid`
- `svg`

Site previews are just frames:

```json
{
  "id": "frame_preview",
  "type": "frame",
  "kind": "site",
  "x": 0,
  "y": 0,
  "width": 1024,
  "height": 768,
  "label": "App preview",
  "background": "#ffffff",
  "url": "http://127.0.0.1:5173",
  "imageData": null,
  "generating": false,
  "priorBounds": null
}
```

Content frames may include `source` and `flatten`. When `flatten` is false or omitted, rich content remains an editable frame and its source is written under `.canvas/assets/`. When `flatten` is true, the content is intended to become native canvas primitives.

Objects can attach to a parent using either `parentId` or `parentFrameId`.

## Patch Contract

`canvas.apply_patch` and internal bridge endpoints use `CanvasPatch`:

```ts
type CanvasPatch =
  | { op: 'create'; objects: CanvasObject[]; select?: boolean }
  | { op: 'update'; id: string; changes: Partial<CanvasObject> }
  | { op: 'delete'; ids: string[] }
  | { op: 'select'; ids: string[] }
  | { op: 'viewport'; x: number; y: number; scale: number };
```

Patch behavior:

- `create` normalizes objects and ignores IDs that already exist.
- `update` shallow-merges `changes` into the matching object.
- `delete` removes matching objects and removes them from selection.
- `select` filters requested IDs to existing objects.
- `viewport` replaces the stored viewport.

Agents should prefer targeted patches over whole-document replacement.

## Local HTTP Bridge

The local app server exposes additional non-MCP endpoints used by the browser bridge:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Returns `{ ok, appUrl, mcpHttpUrl, documentPath, helperVersion }`. |
| `GET /api/document` | Returns the persisted canvas document. |
| `POST /api/document` | Replaces the persisted document with a normalized document. |
| `POST /api/patch` | Applies a `CanvasPatch` or patch array. |
| `GET /api/changes?since=<seq>` | Returns LLM/human change entries after `seq` plus `latestSeq`. |
| `GET /api/screenshot-request` | Returns the current screenshot request, if any. |
| `POST /api/screenshot-response` | Stores the browser's screenshot response. |
| Static files | Serves the built app from `dist`, falling back to the package `dist`. |

`src/components/LocalDocumentBridge.tsx` activates only on `localhost` or `127.0.0.1`. It imports the local document on load, posts browser edits back to `/api/document`, polls remote document updates, services screenshot requests, and polls change entries to drive LLM-change UI.

`canvas.get_screenshot` writes a screenshot request to local state. The browser app polls the request endpoint, captures via the registered canvas screenshot handler, posts a response, and the MCP tool returns `{ id, target, scale, capturedAt, imageData }`. The default timeout is `12000ms`.

## Persistence

In MCP/local-helper mode, Canvas stores project data under `.canvas/` in the current workspace:

Important files:

- `.canvas/canvas.json`: canonical canvas document.
- `.canvas/assets/`: editable source assets for HTML, Markdown, Mermaid, and SVG content frames.
- `.canvas/runtime/screenshot-request.json`: pending screenshot request.
- `.canvas/runtime/screenshot-response.json`: latest screenshot response.
- `.canvas/runtime/changes.ndjson`: append-only change log.
- `.canvas/runtime/logs/`: reserved log directory.

Browser-only hosted mode still uses browser IndexedDB. Local MCP mode treats `.canvas/` as canonical so agents can edit asset files directly in the same workspace.

## CLI Surface

The `canvas` binary supports:

| Command | Purpose |
| --- | --- |
| `canvas serve` | Start stdio MCP and the local Canvas app. |
| `canvas http` | Start the local Canvas app and HTTP MCP endpoint. |
| `canvas setup` | Detect supported MCP clients and print or write configuration. |
| `canvas doctor` | Check Node/npm, port state, app health, HTTP MCP reachability, URLs, and workspace `.canvas` path. |
| `canvas version` | Print helper version, app version, MCP protocol version, and HTTP URL. |
| `canvas update` | Re-run setup instructions. |

In package mode, `serve` performs a best-effort daily update check against the npm registry before starting.
