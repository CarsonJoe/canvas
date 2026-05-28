## Server Files — `packages/canvas-mcp/server/`

### `canvas-app-server.mjs`
- HTTP server on port **3762** (configurable)
- Serves built React app from `dist/`
- REST API for document sync and assets
- MCP over HTTP endpoint (`/mcp`)

### `canvas-local-core.mjs`
- Document persistence to `.canvas/canvas.json`
- Asset management (`.canvas/assets/*.md`)
- Change sequence tracking (`.canvas/runtime/changes.ndjson`)
- Screenshot request/response relay
- Object normalization and patch application

### `canvas-mcp-server.mjs`
- MCP protocol implementation (stdio + HTTP)
- Registers all 11 MCP tools with schemas
- Bridges tool calls → document store operations
- Canvas usage guide embedded as `CANVAS_GUIDE`
