## Canvas Object Types — `src/types/canvas.ts`

| Type | Key Properties |
|------|---------------|
| `stroke` | `points[]` flat x/y array, per-point pressure |
| `rect` | x, y, width, height, fill, stroke, cornerRadius |
| `ellipse` | x, y (center), radiusX, radiusY, fill, stroke |
| `line` | x1, y1, x2, y2, stroke, strokeWidth |
| `arrow` | x1, y1, x2, y2, cx/cy (curve), stroke |
| `text` | x, y, text, fontSize, color, fontFamily |
| `comment` | x, y, text, resolved (boolean) |
| `frame` | x, y, width, height, label, background, **kind** |

**Frame kinds:** `plain` · `image` · `site` (URL iframe) · `markdown` · `html` · `mermaid` · `svg`

**Nesting:** objects use `parentFrameId` to belong to a frame
