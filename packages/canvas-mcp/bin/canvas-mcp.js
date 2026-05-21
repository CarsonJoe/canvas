#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.COGNIBOOM_CANVAS_PACKAGE_MODE ??= '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const command = process.argv[2] ?? 'setup';
const host = '127.0.0.1';
const port = Number(process.env.CANVAS_PORT ?? 3762);
const appUrl = `http://${host}:${port}`;
const mcpHttpUrl = `${appUrl}/mcp`;
const localCliPath = path.join(packageRoot, 'bin', 'canvas-mcp.js');
const localCliCommand = `node "${localCliPath}"`;
const isRepoCheckout = fsExists(path.join(repoRoot, 'scripts', 'canvas-mcp-server.mjs'));
process.env.COGNIBOOM_CANVAS_HELPER_VERSION ??= packageJson.version;

const httpCommand = isRepoCheckout ? `${localCliCommand} http` : 'canvas http';
const doctorCommand = isRepoCheckout ? `${localCliCommand} doctor` : 'canvas doctor';

async function importScript(relativePath) {
  const packageScript = path.join(packageRoot, 'server', path.basename(relativePath));
  if (fsExists(packageScript)) return import(pathToFileURL(packageScript).href);
  return import(pathToFileURL(path.join(repoRoot, relativePath)).href);
}

function fsExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getDataDir() {
  if (process.env.COGNIBOOM_CANVAS_DATA_DIR) return path.resolve(process.env.COGNIBOOM_CANVAS_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CogniboomCanvas');
  if (process.platform === 'darwin') return path.join(process.env.HOME ?? os.homedir(), 'Library', 'Application Support', 'CogniboomCanvas');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.local', 'share'), 'cogniboom-canvas');
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const request = https.get(
      'https://registry.npmjs.org/@cogniboom%2Fcanvas/latest',
      { headers: { accept: 'application/json' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body).version ?? null); } catch { resolve(null); }
        });
      }
    );
    request.on('error', () => resolve(null));
    request.setTimeout(5000, () => { request.destroy(); resolve(null); });
  });
}

function spawnNpmInstall(version) {
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['install', '-g', `@cogniboom/canvas@${version}`], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function checkAndAutoUpdate() {
  const checkFile = path.join(getDataDir(), 'last-update-check');
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

  try {
    if (Date.now() - fs.statSync(checkFile).mtimeMs < CHECK_INTERVAL) return;
  } catch { /* no file yet, proceed */ }

  try {
    fs.mkdirSync(path.dirname(checkFile), { recursive: true });
    fs.writeFileSync(checkFile, '');
  } catch { return; }

  const latest = await fetchLatestVersion();
  if (!latest || latest === packageJson.version) return;

  console.error(`[canvas] Update available: ${packageJson.version} → ${latest}. Installing...`);
  const ok = await spawnNpmInstall(latest);
  if (ok) {
    console.error(`[canvas] Updated to ${latest}. Restart your agent client to use the new version.`);
  } else {
    console.error(`[canvas] Auto-update failed. Run: npm install -g @cogniboom/canvas@latest`);
  }
}

const setupPageUrl = 'https://cogniboom.com/cogniboom-canvas/setup.html';

function openSetupPage() {
  console.log(`Cogniboom Canvas setup guide: ${setupPageUrl}`);
  if (process.env.CANVAS_NO_OPEN === '1' || process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', setupPageUrl] : [setupPageUrl];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function checkPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, body: JSON.parse(body) });
        } catch {
          resolve({ ok: false, body });
        }
      });
    });
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

async function doctor() {
  const node = process.versions.node;
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' });
  const portAvailable = await checkPort();
  const health = await getJson(`${appUrl}/api/health`);
  const mcp = await getJson(mcpHttpUrl);

  console.log(`Cogniboom Canvas MCP doctor
Node: ${node}
npm: ${npm.status === 0 ? npm.stdout.trim() : 'missing'}
Package: ${packageJson.version}
Port ${port}: ${portAvailable ? 'available' : 'in use'}
App health: ${health.ok ? 'healthy' : 'not reachable'}
HTTP MCP: ${mcp.ok ? 'reachable' : 'not reachable'}
App URL: ${appUrl}
MCP URL: ${mcpHttpUrl}
Data dir override: ${process.env.COGNIBOOM_CANVAS_DATA_DIR ?? '(default)'}

${portAvailable ? `Start HTTP mode with: ${httpCommand}` : 'If this is not Canvas, stop the process using port 3762 or set CANVAS_PORT.'}`);
}

async function main() {
  if (command === 'serve') {
    const { startStdioMcpServer } = await importScript('scripts/canvas-mcp-server.mjs');
    checkAndAutoUpdate().catch(() => {});
    await startStdioMcpServer({ startApp: true, open: false });
    return;
  }

  if (command === 'http') {
    const { createCanvasAppServer, openBrowser } = await importScript('scripts/canvas-app-server.mjs');
    const server = createCanvasAppServer();
    server.listen(port, host, () => {
      console.log(`Canvas local app: ${appUrl}`);
      console.log(`Canvas MCP HTTP: ${mcpHttpUrl}`);
      if (process.env.CANVAS_NO_OPEN !== '1' && !process.argv.includes('--no-open')) openBrowser(appUrl);
    });
    return;
  }

  if (command === 'setup') {
    openSetupPage();
    return;
  }

  if (command === 'doctor') {
    await doctor();
    return;
  }

  if (command === 'version') {
    console.log(`helper: ${packageJson.version}
app: 0.1.0
mcp protocol: 2024-11-05
http: ${mcpHttpUrl}`);
    return;
  }

  if (command === 'update') {
    openSetupPage();
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
