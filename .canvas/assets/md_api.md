## REST API — port 3762

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Server info & workspace path |
| `/api/document` | GET | Fetch full canvas JSON |
| `/api/document` | POST | Write canvas JSON (app → server) |
| `/api/changes?since=N` | GET | Incremental change poll |
| `/api/patch` | POST | Apply patch operations |
| `/api/screenshot-request` | GET | Poll for pending screenshot |
| `/api/screenshot-response` | POST | Submit captured PNG |
| `/assets/:id/content` | GET | Get raw asset source |
| `/assets/:id/save` | POST | Save asset edits |
| `/assets/:id/mtime` | GET | Check for external edits |
| `/assets/:id` | GET | Inline asset editor HTML |
| `/mcp` | POST | HTTP MCP endpoint |
