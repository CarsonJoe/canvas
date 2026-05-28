## npm Package — `@cogniboom/canvas`

Install: `npx @cogniboom/canvas setup`

```
packages/canvas-mcp/
├── bin/canvas-mcp.js       CLI entry point
├── bin/build-dist.mjs      copies React build into package
├── server/
│   ├── canvas-app-server.mjs
│   ├── canvas-local-core.mjs
│   └── canvas-mcp-server.mjs
├── dist/                   pre-built React app (bundled)
└── package.json            exports: app-server, document-store, mcp
```

**Build pipeline:**

`npm run build` (Vite) → `build:mcp-package` (copy dist) → `npm publish`

**Auto-deploy:** GitHub Actions on push to `master` → GitHub Pages (web app at cogniboom.github.io/canvas)
