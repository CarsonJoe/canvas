import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyPatches,
  appHost,
  appPort,
  appUrl,
  documentPath,
  helperVersion,
  latestChangeSeq,
  mcpHttpUrl,
  readChangesSince,
  readDocument,
  readScreenshotRequest,
  readWorkingIds,
  repoRoot,
  writeDocument,
  writeScreenshotResponse,
  writeWorkingIds,
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
      } else if (url.pathname === '/api/working' && request.method === 'GET') {
        sendJson(response, 200, { ids: await readWorkingIds() });
      } else if (url.pathname === '/api/working' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        sendJson(response, 200, { ids: await writeWorkingIds(body.ids ?? []) });
      } else if (url.pathname === '/api/changes' && request.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0') || 0;
        const [changes, latest] = await Promise.all([readChangesSince(since), latestChangeSeq()]);
        sendJson(response, 200, { changes, latestSeq: latest });
      } else if (url.pathname === '/api/screenshot-request' && request.method === 'GET') {
        sendJson(response, 200, { request: await readScreenshotRequest() });
      } else if (url.pathname === '/api/screenshot-response' && request.method === 'POST') {
        sendJson(response, 200, await writeScreenshotResponse(JSON.parse(await readBody(request))));
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
