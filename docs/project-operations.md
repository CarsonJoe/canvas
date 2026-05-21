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
   - Serves the local browser app and MCP endpoint.
   - Supports stdio MCP with `canvas serve`.
   - Supports HTTP MCP with `canvas http`.

## Repository Hygiene Rules

Never commit:

- `.env`
- `.env.local`
- `node_modules/`
- `.canvas-local/`
- npm tarballs such as `*.tgz`
- local logs
- local screenshots or generated test output
- API keys or copied secret-bearing config files

Before the first public GitHub push, the safest path is to create a fresh git history.

Recommended cleanup:

```powershell
cd C:\Users\Carson\Desktop\Projects\canvas
Remove-Item -Recurse -Force .git
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .canvas-local -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Remove-Item -Force *.tgz -ErrorAction SilentlyContinue
```

Then inspect ignored and untracked files:

```powershell
git init
git status --short
git check-ignore -v .env node_modules .canvas-local dist
```

Commit only after confirming secrets and generated folders are not staged.

## Required `.gitignore`

Keep at least:

```gitignore
.env
.env.*
!.env.example
node_modules/
dist/
.canvas-local/
canvas-local*.log
*.tgz
npm-debug.log*
vite-dev*.log
```

If a future feature creates local data, screenshots, or generated output, add it to `.gitignore` before running broad `git add` commands.

## Secret Handling

The hosted app must support bring-your-own-key for image generation. Do not embed an OpenAI key in the production build.

Expected model:

- User enters their own API key in the browser.
- Key is stored only in browser storage or session memory.
- Key is never committed, logged, sent to Cogniboom servers, or written into exported canvas documents.
- `.env.example` may document optional local development variables with placeholder values only.

Before every public release:

```powershell
rg "sk-|OPENAI_API_KEY|apiKey|Authorization|Bearer" . --glob "!node_modules/**" --glob "!dist/**" --glob "!packages/canvas-mcp/dist/**"
```

Manually inspect any hits.

## Local Development

Install dependencies:

```powershell
npm install
```

Run the web app:

```powershell
npm run dev
```

Build the web app:

```powershell
npm run build
```

Build the MCP package assets:

```powershell
npm run build:mcp-package
```

Dry-run the npm package:

```powershell
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
5. Verify from a clean directory.
6. Update docs or hosted setup page if commands changed.

### Version Bump

Use semantic versioning:

- Patch: bug fix, doc fix, setup output fix.
- Minor: new backward-compatible commands or tools.
- Major: breaking CLI, MCP, document format, or setup changes.

Edit:

```text
packages/canvas-mcp/package.json
```

Example:

```json
"version": "0.1.1"
```

### Build And Dry Run

```powershell
cd C:\Users\Carson\Desktop\Projects\canvas
npm run pack:mcp-package
```

Expected:

- Package name is `@cogniboom/canvas`.
- Tarball name is `cogniboom-canvas-VERSION.tgz`.
- Tarball contents include:

```text
README.md
bin/canvas-mcp.js
dist/
package.json
server/canvas-app-server.mjs
server/canvas-local-core.mjs
server/canvas-mcp-server.mjs
```

- Tarball should not include:

```text
node_modules/
.env
.canvas-local/
src/
docs/
scripts/
*.log
```

### Publish

```powershell
cd C:\Users\Carson\Desktop\Projects\canvas\packages\canvas-mcp
npm publish --access public --otp=YOUR_6_DIGIT_CODE
```

If npm prompts for browser authentication, complete it and rerun if needed.

If the version already exists, bump the version and publish again. npm versions cannot be overwritten.

### Verify npm

Use a clean directory:

```powershell
cd C:\tmp
npm view @cogniboom/canvas version
npx --yes @cogniboom/canvas@latest version
npx --yes @cogniboom/canvas@latest setup
```

HTTP mode smoke test:

```powershell
$env:CANVAS_PORT='3873'
$env:CANVAS_NO_OPEN='1'
npx --yes @cogniboom/canvas@latest http
```

In another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3873/api/health
Invoke-RestMethod http://127.0.0.1:3873/mcp
```

Expected:

- `/api/health` returns `ok: true`.
- `/mcp` returns `ok: true`.

### Deprecating Old Package Names

If `@cogniboom/canvas-mcp` remains published, deprecate it after `@cogniboom/canvas` works:

```powershell
npm deprecate @cogniboom/canvas-mcp@"*" "Renamed to @cogniboom/canvas"
```

## GitHub Repository Setup

After deleting old history and confirming ignored files:

```powershell
git init
git add .
git status --short
git commit -m "Initial public release"
git branch -M main
git remote add origin https://github.com/Cogniboom/canvas.git
git push -u origin main
```

Use the actual GitHub owner/repo URL.

Before pushing, run:

```powershell
git status --short
rg "sk-|OPENAI_API_KEY|Bearer|Authorization" . --glob "!node_modules/**" --glob "!dist/**" --glob "!packages/canvas-mcp/dist/**"
```

## GitHub Pages Release

The hosted app should be built from the repo and deployed to GitHub Pages.

Recommended approach:

- Use GitHub Actions.
- Build with `npm ci` and `npm run build`.
- Upload `dist/` as the Pages artifact.
- Deploy from the `main` branch.

Required repo settings:

1. GitHub repo Settings.
2. Pages.
3. Source: GitHub Actions.

Add a workflow such as:

```yaml
name: Deploy Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

This repo has `.github/workflows/deploy-pages.yml` configured for a GitHub Pages repo path:

```text
https://OWNER.github.io/canvas/
```

The workflow sets:

```text
VITE_BASE_PATH=/canvas/
```

Local and npm package builds keep the default base path `/`.

For a custom domain like `cogniboom.com/canvas`, keep `/canvas/`. For a root custom domain, change the workflow env to:

```text
VITE_BASE_PATH=/
```

## Hosted Site Verification

After Pages deploys, test:

1. Open the hosted Canvas URL.
2. Confirm the app loads without console 404s.
3. Open the top-right menu.
4. Click `Connect MCP`.
5. Confirm setup page loads.
6. Confirm setup page uses:

```powershell
npx @cogniboom/canvas setup
```

7. Confirm setup page explains:

- why MCP needs a local helper
- local app URL
- MCP HTTP URL
- client setup snippets
- verification prompt
- troubleshooting
- security model

## Another Machine Verification

Use a machine that has not cloned this repo.

Prerequisites:

- Node 18 or newer.
- npm.
- A browser.
- An MCP-capable client for manual client tests.

Test npm install path:

```powershell
cd C:\tmp
npx --yes @cogniboom/canvas@latest setup
npx --yes @cogniboom/canvas@latest doctor
```

Test HTTP helper:

```powershell
npx --yes @cogniboom/canvas@latest http
```

Open:

```text
http://127.0.0.1:3762
```

Expected:

- Browser app opens.
- Local app loads from package assets.
- No repo clone is required.

Test MCP verification prompt in an agent:

```text
Create a red rectangle in Cogniboom Canvas, then take a screenshot and tell me what you see.
```

Expected:

- Agent lists Canvas tools.
- Agent creates an object.
- Browser shows the object.
- Screenshot succeeds when the local browser tab is open.

## Release Order

For a normal release:

1. Implement and test app changes.
2. Run `npm run build`.
3. Run `npm run pack:mcp-package`.
4. Publish npm package if helper changed.
5. Push to GitHub.
6. Wait for Pages deploy.
7. Verify hosted site.
8. Verify `npx @cogniboom/canvas@latest` from a clean directory.
9. Test on another machine before announcing.

If only hosted app changed, npm publish may not be needed unless the local helper package also needs updated bundled assets.

If setup page changed, rebuild and republish npm too, because the package ships `dist/`.

## Rollback

GitHub Pages:

- Revert the commit and push.
- Or rerun a previous successful deployment if available.

npm:

- Do not rely on unpublish.
- Publish a fixed patch version.
- Deprecate a bad version if needed:

```powershell
npm deprecate @cogniboom/canvas@VERSION "Use VERSION+1"
```

## Current Pre-Public Checklist

Before the first clean GitHub push:

- Delete old `.git`.
- Confirm `.gitignore` covers secrets and generated folders.
- Add bring-your-own-key image generation.
- Confirm no OpenAI key is bundled into the app.
- Add GitHub Pages workflow.
- Run full local build.
- Run npm package dry-run.
- Publish `@cogniboom/canvas`.
- Verify from `C:\tmp`.
- Verify on another machine.
