## MCP Tool Registry

Exposed via `@modelcontextprotocol/sdk`

| Tool | Purpose |
|------|---------|
| `canvas_get_document` | Read full canvas state (objects, viewport, selection) |
| `canvas_create_objects` | Add shapes, frames, text, arrows, strokes |
| `canvas_update_objects` | Patch existing objects by ID |
| `canvas_delete_objects` | Remove objects by ID array |
| `canvas_duplicate_objects` | Clone objects with optional offset |
| `canvas_apply_patch` | Batch create / update / delete + viewport ops |
| `canvas_get_object_info` | Inspect a single object + bounds |
| `canvas_get_children` | List children of a frame or object |
| `canvas_get_tree_summary` | Hierarchical tree view of all objects |
| `canvas_get_screenshot` | Capture PNG of canvas, frame, or selection |
| `canvas_launch` | Open the app in the browser |

---

### Transport Modes
- **stdio** — default for Claude Desktop / Cursor (`canvas serve`)
- **HTTP/SSE** — for networked clients (`canvas http`)

### Change Sync Flow
1. MCP tool writes patch → `canvas.json` updated
2. `LocalDocumentBridge` polls `/api/changes` every 900ms
3. Zustand store merges the diff and re-renders
4. Screenshot requests relay via `.canvas/runtime/` files
