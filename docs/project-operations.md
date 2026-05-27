# Cogniboom Canvas Project Operations

This runbook describes how to manage Cogniboom Canvas after the repo is cleaned up and published. It covers repository hygiene, GitHub Pages, npm releases, MCP helper verification, and machine-to-machine testing.

## Project Pieces

The project has two public surfaces:

1. Hosted Canvas web app
   - Built with Vite.
   - Hosted by GitHub Pages.
   - Runs entirely in the browser unless the local helper is connected.

2. Local MCP helper package
   - Published to npm as `@cogniboom/canvas`.
   - Exposes the `canvas` binary.
   - Installed globally: `npm install -g @cogniboom/canvas`.
   - Supports stdio MCP with `canvas serve`.
   - Supports HTTP MCP with `canvas http`.
   - Auto-updates on `canvas serve` launch (checks npm once per 24 h).

## Secret Handling

The hosted app must support bring-your-own-key for image generation. Do not embed an OpenAI key in the production build.

## Data Storage

Browser-only hosted mode stores canvas data in browser IndexedDB.

Local MCP mode stores project data in the current workspace:

```text
.canvas/
  canvas.json
  assets/
  runtime/
    screenshot-request.json
    screenshot-response.json
    changes.ndjson
    logs/
```

`canvas.json` and `assets/` are project artifacts. `runtime/` is helper coordination state and should stay ignored.

## Local Development

Install dependencies:

```sh
npm install
```

Run the web app:

```sh
npm run dev
```

Build the web app:

```sh
npm run build
```

Build the MCP package assets:

```sh
npm run build:mcp-package
```

Dry-run the npm package:

```sh
npm run pack:mcp-package
```

## npm Package Release

Package source directory:

```text
packages/canvas-mcp/
```

Published package:

```text
@cogniboom/canvas
```

Published binary:

```text
canvas
```

### Release Checklist

1. Update version in `packages/canvas-mcp/package.json`.
2. Run build and package dry-run.
3. Verify tarball contents.
4. Publish to npm.
5. Verify from a clean environment.
6. Update docs or hosted setup page if commands changed.

### Version Bump

Edit `packages/canvas-mcp/package.json`:

```json
"version": "0.1.1"
```

### Build And Dry Run

```sh
npm run pack:mcp-package
```

Expected tarball contents:

```text
README.md
bin/canvas-mcp.js
dist/
package.json
server/canvas-app-server.mjs
server/canvas-local-core.mjs
server/canvas-mcp-server.mjs
```

### Publish

```sh
cd packages/canvas-mcp
npm publish --access public
```

If npm prompts for browser authentication, complete it and rerun if needed.

If the version already exists, bump the version and publish again. npm versions cannot be overwritten.

### Verify npm

Install globally in a clean shell to confirm the published package works:

```sh
npm install -g @cogniboom/canvas@latest
canvas version
canvas setup --no-open
```

HTTP mode smoke test:

```sh
CANVAS_PORT=3873 CANVAS_NO_OPEN=1 canvas http
```

In another terminal:

```sh
curl http://127.0.0.1:3873/api/health
curl http://127.0.0.1:3873/mcp
```

Expected:

- `/api/health` returns `ok: true`.
- `/mcp` returns `ok: true`.

Uninstall after testing:

```sh
npm uninstall -g @cogniboom/canvas
```

## GitHub Pages Release

Auto deploys from the `master` branch.

## Release Order

For a normal release:

1. Implement and test app changes.
2. Run `npm run build`.
3. Run `npm run pack:mcp-package`.
4. Publish npm package if helper changed.
5. Push to GitHub.
6. Wait for Pages deploy.
7. Verify hosted site and setup page at `https://cogniboom.com/cogniboom-canvas/setup.html`.
8. Install globally and verify: `npm install -g @cogniboom/canvas@latest && canvas version`.
9. Test on another machine before announcing.

## Rollback

GitHub Pages:

- Revert the commit and push.
- Or rerun a previous successful deployment if available.

npm:

- Do not rely on unpublish.
- Publish a fixed patch version.
- Deprecate a bad version if needed:

```sh
npm deprecate @cogniboom/canvas@VERSION "Use VERSION+1"
```
