import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyPatches,
  appendChange,
  appHost,
  appPort,
  appUrl,
  assetMtime,
  documentPath,
  helperVersion,
  latestChangeSeq,
  mcpHttpUrl,
  readChangesSince,
  readAssetSource,
  readDocument,
  readScreenshotRequest,
  repoRoot,
  writeAssetSource,
  writeDocument,
  writeScreenshotResponse,
} from './canvas-local-core.mjs';
import { handleMcpMessage } from './canvas-mcp-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDistDir = path.resolve(__dirname, '..', 'packages', 'canvas-mcp', 'dist');
const distDir = process.env.COGNIBOOM_CANVAS_DIST_DIR
  ? path.resolve(process.env.COGNIBOOM_CANVAS_DIST_DIR)
  : process.env.COGNIBOOM_CANVAS_PACKAGE_MODE === '1'
    ? path.resolve(__dirname, '..', 'dist')
    : path.join(repoRoot, 'dist');
const port = Number(process.env.CANVAS_PORT ?? process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] ?? appPort);
const host = appHost;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(JSON.stringify(data));
}

function sendMcpJson(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, mcp-session-id',
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
  const servingDir = await fs.access(path.join(distDir, 'index.html')).then(() => distDir).catch(() => packageDistDir);
  const filePath = path.resolve(servingDir, relativePath);
  if (!filePath.startsWith(servingDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    response.end(file);
  } catch {
    const index = await fs.readFile(path.join(servingDir, 'index.html'));
    response.writeHead(200, { 'content-type': contentTypes['.html'], 'cache-control': 'no-store' });
    response.end(index);
  }
}

function buildAssetEditorHtml(id, source, format) {
  const escaped = source.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const isHtml = format === 'html' || format === 'svg';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#ddd;height:100vh;display:flex;flex-direction:column}
  #toolbar{padding:6px 10px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;display:flex;gap:6px;align-items:center}
  button{padding:3px 10px;border:1px solid #3a3a3a;border-radius:4px;background:#222;color:#aaa;cursor:pointer;font-size:12px}
  button.active,button:hover{background:#6366f1;color:#fff;border-color:#6366f1}
  #preview{flex:1;overflow:auto;padding:${isHtml ? '0' : '20px 24px'};background:${isHtml ? '#fff' : '#111'}}
  iframe{width:100%;height:100%;border:0;display:block}
  #editor{flex:1;background:#0d0d0d;color:#ddd;border:0;outline:0;padding:16px;font-family:Menlo,monospace;font-size:13px;line-height:1.6;resize:none;display:none}
  #status{font-size:11px;color:#666;margin-left:auto}
</style>
</head>
<body>
<div id="toolbar">
  <button id="btnPreview" class="active" onclick="showPreview()">Preview</button>
  <button id="btnEdit" onclick="showEdit()">Edit</button>
  <span id="status"></span>
</div>
<div id="preview"></div>
<textarea id="editor" spellcheck="false"></textarea>
${isHtml ? '' : '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>'}
<script>
const ASSET_ID = ${JSON.stringify(id)};
const FORMAT = ${JSON.stringify(format)};
let lastMtime = null;
let saveTimer = null;
function editor(){ return document.getElementById('editor'); }
function render(src) {
  const preview = document.getElementById('preview');
  if (FORMAT === 'html' || FORMAT === 'svg') {
    preview.innerHTML = '<iframe id="previewFrame" sandbox="allow-scripts allow-same-origin"></iframe>';
    const blob = new Blob([src], { type: FORMAT === 'svg' ? 'image/svg+xml' : 'text/html' });
    document.getElementById('previewFrame').src = URL.createObjectURL(blob);
  } else {
    preview.innerHTML = typeof marked !== 'undefined' ? marked.parse(src) : '<pre>' + src + '</pre>';
  }
}
function showPreview() {
  document.getElementById('preview').style.display = '';
  editor().style.display = 'none';
  document.getElementById('btnPreview').classList.add('active');
  document.getElementById('btnEdit').classList.remove('active');
  render(editor().value);
}
function showEdit() {
  document.getElementById('preview').style.display = 'none';
  editor().style.display = '';
  document.getElementById('btnEdit').classList.add('active');
  document.getElementById('btnPreview').classList.remove('active');
  editor().focus();
}
async function save() {
  try {
    await fetch('/assets/' + ASSET_ID + '/save', { method: 'POST', headers: {'content-type':'text/plain'}, body: editor().value });
    document.getElementById('status').textContent = 'Saved';
    setTimeout(() => { document.getElementById('status').textContent = ''; }, 1200);
  } catch { document.getElementById('status').textContent = 'Save failed'; }
}
editor().addEventListener('input', () => {
  render(editor().value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
});
async function pollExternal() {
  try {
    const r = await fetch('/assets/' + ASSET_ID + '/mtime');
    const { mtime } = await r.json();
    if (lastMtime !== null && mtime !== lastMtime) {
      const res = await fetch('/assets/' + ASSET_ID + '/content');
      const text = await res.text();
      editor().value = text;
      render(text);
    }
    lastMtime = mtime;
  } catch {}
  setTimeout(pollExternal, 1500);
}
editor().value = \`${escaped}\`;
render(editor().value);
pollExternal();
</script>
</body>
</html>`;
}

async function handleAssetRequest(pathname, request, response) {
  const parts = pathname.replace(/^\/assets\//, '').split('/');
  const id = parts[0];
  const sub = parts[1] ?? '';

  if (!id || !/^[\w-]+$/.test(id)) {
    response.writeHead(400);
    response.end('Bad id');
    return;
  }

  if (sub === 'content') {
    const asset = await readAssetSource(id);
    if (!asset) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(asset.content);
    return;
  }

  if (sub === 'mtime') {
    sendJson(response, 200, { mtime: await assetMtime(id) });
    return;
  }

  if (sub === 'save' && request.method === 'POST') {
    const asset = await readAssetSource(id);
    const format = asset?.format ?? 'markdown';
    await writeAssetSource(id, await readBody(request), format);
    await appendChange({ author: 'user', op: 'asset_save', objectIds: [id] }).catch(() => {});
    sendJson(response, 200, { ok: true });
    return;
  }

  const asset = await readAssetSource(id);
  if (!asset) {
    response.writeHead(404);
    response.end('Asset not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(buildAssetEditorHtml(id, asset.content, asset.format));
}

export function createCanvasAppServer() {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }

      const url = new URL(request.url ?? '/', `http://${host}:${port}`);
      if (url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, appUrl, mcpHttpUrl, documentPath, helperVersion });
      } else if (url.pathname === '/mcp' && request.method === 'GET') {
        sendMcpJson(response, 200, { ok: true, transport: 'http', endpoint: mcpHttpUrl });
      } else if (url.pathname === '/mcp' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        if (Array.isArray(body)) {
          const results = await Promise.all(body.map((message) => handleMcpMessage(message, { transport: 'http' })));
          sendMcpJson(response, 200, results.filter(Boolean));
        } else {
          const result = await handleMcpMessage(body, { transport: 'http' });
          if (result) sendMcpJson(response, 200, result);
          else response.writeHead(202).end();
        }
      } else if (url.pathname === '/api/document' && request.method === 'GET') {
        sendJson(response, 200, await readDocument());
      } else if (url.pathname === '/api/document' && request.method === 'POST') {
        const document = JSON.parse(await readBody(request));
        sendJson(response, 200, await writeDocument(document));
      } else if (url.pathname === '/api/patch' && request.method === 'POST') {
        const patch = JSON.parse(await readBody(request));
        sendJson(response, 200, await applyPatches(patch));
      } else if (url.pathname === '/api/changes' && request.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0') || 0;
        const [changes, latest] = await Promise.all([readChangesSince(since), latestChangeSeq()]);
        sendJson(response, 200, { changes, latestSeq: latest });
      } else if (url.pathname === '/api/screenshot-request' && request.method === 'GET') {
        sendJson(response, 200, { request: await readScreenshotRequest() });
      } else if (url.pathname === '/api/screenshot-response' && request.method === 'POST') {
        sendJson(response, 200, await writeScreenshotResponse(JSON.parse(await readBody(request))));
      } else if (/^\/assets\/[\w-]+(\/|$)/.test(url.pathname)) {
        await handleAssetRequest(url.pathname, request, response);
      } else {
        await serveStatic(request, response);
      }
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function openBrowser(url) {
  if (process.env.CANVAS_NO_OPEN === '1' || process.argv.includes('--no-open')) return;
  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createCanvasAppServer();
  server.listen(port, host, () => {
    const url = appUrl;
    console.log(`Canvas local app: ${url}`);
    console.log(`Canvas MCP HTTP: ${mcpHttpUrl}`);
    console.log(`Document: ${documentPath}`);
    openBrowser(url);
  });
}
