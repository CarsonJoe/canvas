## Zustand Store — `useCanvasStore`

**Document state**
- `objects[]` — all canvas objects
- `selectedIds[]` — current selection
- `updatedAt` — ISO timestamp for sync

**Viewport**
- `stageX`, `stageY`, `stageScale`

**Tool settings**
- `tool`, `brushColor/Size/Opacity`
- `fillColor`, `shapeStrokeColor/Width`
- `fontSize`, `fontColor`, `theme`

**History**
- `past[]` / `future[]` — undo/redo snapshots

**Persistence**
- IndexedDB (`canvas-app-db` / `kv` store)
- Fallback: localStorage
- Auto-migration on startup
