#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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

const setupCommand = isRepoCheckout ? `${localCliCommand} setup` : 'npx --yes @cogniboom/canvas@latest setup';
const serveCommand = isRepoCheckout ? `node "${localCliPath}" serve` : 'npx --yes @cogniboom/canvas@latest serve';
const httpCommand = isRepoCheckout ? `${localCliCommand} http` : 'npx --yes @cogniboom/canvas@latest http';
const doctorCommand = isRepoCheckout ? `${localCliCommand} doctor` : 'npx --yes @cogniboom/canvas@latest doctor';
const configCommand = isRepoCheckout ? 'node' : 'npx';
const configArgs = isRepoCheckout ? [localCliPath, 'serve'] : ['--yes', '@cogniboom/canvas@latest', 'serve'];

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

function printSetup() {
  console.log(`Cogniboom Canvas MCP setup

Why the helper is local:
  Browser-hosted Canvas cannot expose stdio tools or bind local ports. This helper serves Canvas on ${appUrl} and exposes MCP at ${mcpHttpUrl}.

Setup command:
  ${setupCommand}

Claude Code:
  claude mcp add cogniboom-canvas -- ${serveCommand}

Claude Desktop / Cursor JSON:
  {
    "mcpServers": {
      "cogniboom-canvas": {
        "command": ${JSON.stringify(configCommand)},
        "args": ${JSON.stringify(configArgs)}
      }
    }
  }

Codex TOML:
  [mcp_servers.cogniboom_canvas]
  command = ${JSON.stringify(configCommand)}
  args = ${JSON.stringify(configArgs)}
  startup_timeout_sec = 20
  tool_timeout_sec = 60

HTTP clients:
  Run: ${httpCommand}
  URL: ${mcpHttpUrl}

Verification prompt:
  Create a red rectangle in Cogniboom Canvas, then take a screenshot and tell me what you see.

Troubleshooting:
  1. Restart or reload your agent client.
  2. Run: ${doctorCommand}
  3. Open: ${appUrl}/api/health

Security:
  The server binds only to 127.0.0.1 by default and does not expose arbitrary filesystem tools.

Update:
  npx @cogniboom/canvas@latest setup`);
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
    await startStdioMcpServer({ startApp: true, open: process.env.CANVAS_NO_OPEN !== '1' && !process.argv.includes('--no-open') });
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
    printSetup();
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
    console.log('Update with: npx @cogniboom/canvas@latest setup');
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
