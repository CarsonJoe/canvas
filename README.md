# Cogniboom Canvas

An infinite canvas that AI agents can read and write through MCP (Model Context Protocol).

Open the canvas in your browser, connect a local helper, and your AI agent can place shapes, draw diagrams, annotate frames, take screenshots, and link to other local projects — all in real time.

## How it works

The project has two parts:

**Hosted web app** — a browser-based infinite canvas deployed on GitHub Pages. It runs entirely in the browser. Canvas documents are stored in IndexedDB locally.

**Local MCP helper** (`@cogniboom/canvas`) — an npm package you install once. It serves the canvas app locally and exposes an MCP endpoint so agent clients (Claude, Cursor, etc.) can interact with the live canvas.

When both are running, the helper bridges your agent client to the open browser tab. The agent can read the document state, create and update objects, capture screenshots, and link external projects.

## Quick start

Install and run the local helper:

```sh
npx @cogniboom/canvas setup
```

This opens the setup guide in your browser with instructions for connecting to your agent client.

### MCP modes

**Stdio** (for Claude Desktop, Cursor, etc.):

```sh
canvas serve
```

**HTTP** (for HTTP-capable MCP clients):

```sh
canvas http
# MCP endpoint: http://127.0.0.1:3762/mcp
```

### Helper commands

```text
canvas serve    Start stdio MCP and the local Canvas app
canvas http     Start HTTP MCP and the local Canvas app
canvas setup    Open the setup guide in your browser
canvas doctor   Diagnose local setup
canvas version  Print helper and protocol versions
canvas update   Open the setup guide to check for updates
```

## What agents can do

Through MCP, an agent can:

- Read the full document, selection, or individual objects
- Create shapes (rect, ellipse, line, arrow, text, frame, stroke)
- Update, move, duplicate, or delete objects by ID
- Capture a screenshot of the canvas or a specific frame
- Annotate frames with text, arrows, and strokes
- Link local projects and set preview URLs for site frames
- Apply structured patch operations for batch edits

## Canvas objects

The canvas supports: **frames**, **rectangles**, **ellipses**, **lines**, **arrows**, **text**, and **freehand strokes** (with pen pressure sensitivity). Frames can contain other objects and can display embedded site previews.

## Image generation

The hosted app supports bring-your-own-key image generation. No OpenAI key is embedded in the build.

## Development

```sh
npm install
npm run dev          # start Vite dev server
npm run build        # production build
```

Build and dry-run the MCP npm package:

```sh
npm run build:mcp-package   # build app + copy assets into packages/canvas-mcp
npm run pack:mcp-package    # pack tarball for inspection
```

Publish:

```sh
cd packages/canvas-mcp
npm publish --access public
```

See `docs/project-operations.md` for the full release checklist.

## Stack

- React + Konva (`react-konva`) for the canvas renderer
- Zustand for state, persisted to IndexedDB
- Vite + TypeScript
- Tailwind CSS
- MCP helper: plain Node.js, stdio and HTTP transports
- Hosting: GitHub Pages (auto-deploys from `master`)
- npm package: `@cogniboom/canvas`
