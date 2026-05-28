## React Component Tree

```
App
├── LocalDocumentBridge   headless, 900ms polling sync
├── LeftToolbar           tool palette & brush settings
├── InfiniteCanvas        Konva Stage (main renderer)
│   ├── FrameComponents   recursive frame renderer
│   ├── StrokeLines       freehand with pressure
│   ├── RectShapes
│   ├── EllipseShapes
│   ├── LineShapes / ArrowShapes
│   ├── TextShapes / CommentShapes
│   └── Transformer       selection handles
├── RadialMenu            right-click context menu
├── SceneMenu             scene-level operations
├── BottomBar             zoom / document info
└── LlmChangesToast       MCP change notifications
```
