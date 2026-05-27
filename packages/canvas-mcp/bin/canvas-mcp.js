#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
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
  return path.join(process.cwd(), '.canvas', 'runtime');
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
  if (!latest || latest === packageJson.version) return false;

  console.error(`[canvas] Update available: ${packageJson.version} → ${latest}. Installing...`);
  const ok = await spawnNpmInstall(latest);
  if (ok) {
    console.error(`[canvas] Updated to ${latest}.`);
    return true;
  } else {
    console.error(`[canvas] Auto-update failed. Run: npm install -g @cogniboom/canvas@latest`);
    return false;
  }
}

const setupPageUrl = 'https://cogniboom.com/cogniboom-canvas/setup.html';

// ── Client registry ──────────────────────────────────────────────────────────

function getClients() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';

  const vscodeUserDir = win
    ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User')
    : mac
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Code', 'User');

  const vscodeStorage = path.join(vscodeUserDir, 'globalStorage');

  const windsurfDir = win
    ? path.join(process.env.USERPROFILE ?? home, '.codeium', 'windsurf')
    : path.join(home, '.codeium', 'windsurf');

  const zedConfigDir = win
    ? path.join(process.env.APPDATA ?? '', 'Zed')
    : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'zed');

  const claudeDesktopConfigPath = win
    ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : mac
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'claude', 'claude_desktop_config.json');

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      detect: () => {
        const cmd = win ? 'where' : 'which';
        try { return spawnSync(cmd, ['claude'], { encoding: 'utf8', stdio: 'pipe' }).status === 0; }
        catch { return false; }
      },
      configure: async () => {
        const r = spawnSync('claude', ['mcp', 'add', 'canvas', 'canvas', 'serve'], { encoding: 'utf8', stdio: 'pipe' });
        const out = (r.stdout ?? '') + (r.stderr ?? '');
        if (r.status === 0) return { ok: true };
        if (out.toLowerCase().includes('already')) return { ok: true, already: true };
        return { ok: false };
      },
      manual: () => `  Run: claude mcp add canvas canvas serve`,
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      configPath: claudeDesktopConfigPath,
      detect: () => fs.existsSync(claudeDesktopConfigPath),
      mergeKey: 'mcpServers',
      note: 'Restart Claude Desktop to apply.',
      manual: () => `  File: ${claudeDesktopConfigPath}\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      detect: () => fs.existsSync(path.join(home, '.cursor')),
      mergeKey: 'mcpServers',
      manual: () => `  File: ${path.join(home, '.cursor', 'mcp.json')}\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      configPath: path.join(windsurfDir, 'mcp_config.json'),
      detect: () => fs.existsSync(windsurfDir),
      mergeKey: 'mcpServers',
      manual: () => `  File: ${path.join(windsurfDir, 'mcp_config.json')}\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'vscode',
      name: 'VS Code (Copilot)',
      configPath: path.join(vscodeUserDir, 'mcp.json'),
      detect: () => fs.existsSync(vscodeUserDir),
      mergeKey: 'servers',
      note: 'Reload VS Code to apply (Ctrl+Shift+P → "Developer: Reload Window").',
      manual: () => `  File: ${path.join(vscodeUserDir, 'mcp.json')}\n  Add:\n${jsonSnippet('servers')}`,
    },
    {
      id: 'zed',
      name: 'Zed',
      configPath: path.join(zedConfigDir, 'settings.json'),
      detect: () => fs.existsSync(zedConfigDir),
      mergeKey: 'context_servers',
      manual: () => `  File: ${path.join(zedConfigDir, 'settings.json')}\n  Add:\n${jsonSnippet('context_servers')}`,
    },
    {
      id: 'cline',
      name: 'Cline',
      configPath: path.join(vscodeStorage, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      detect: () => fs.existsSync(path.join(vscodeStorage, 'saoudrizwan.claude-dev')),
      mergeKey: 'mcpServers',
      manual: () => `  File: [VS Code globalStorage]/saoudrizwan.claude-dev/settings/cline_mcp_settings.json\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'roo-code',
      name: 'Roo Code',
      configPath: path.join(vscodeStorage, 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
      detect: () => fs.existsSync(path.join(vscodeStorage, 'rooveterinaryinc.roo-cline')),
      mergeKey: 'mcpServers',
      manual: () => `  File: [VS Code globalStorage]/rooveterinaryinc.roo-cline/settings/mcp_settings.json\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'jetbrains',
      name: 'JetBrains (Junie)',
      configPath: path.join(home, '.junie', 'mcp', 'mcp.json'),
      detect: () => fs.existsSync(path.join(home, '.junie')),
      mergeKey: 'mcpServers',
      manual: () => `  File: ~/.junie/mcp/mcp.json\n  Add:\n${jsonSnippet('mcpServers')}`,
    },
    {
      id: 'continue',
      name: 'Continue.dev',
      detect: () => fs.existsSync(path.join(home, '.continue')),
      manual: () => `  File: ~/.continue/config.yaml\n  Add:\n\n    mcpServers:\n      - name: canvas\n        command: canvas\n        args:\n          - serve\n`,
    },
  ];
}

function jsonSnippet(rootKey) {
  const obj = { [rootKey]: { canvas: { command: 'canvas', args: ['serve'] } } };
  return JSON.stringify(obj, null, 2).split('\n').map(l => '  ' + l).join('\n');
}

function readJsonFileSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function safeDetect(client) {
  try { return client.detect(); } catch { return false; }
}

async function configureClientAuto(client) {
  if (client.configure) {
    try {
      const result = await client.configure();
      if (result.already) {
        console.log(`  ✓ ${client.name} — already configured`);
      } else if (result.ok) {
        console.log(`  ✓ ${client.name} — configured`);
      } else {
        console.log(`  ~ ${client.name} — run manually:\n${client.manual()}\n`);
      }
    } catch {
      console.log(`  ~ ${client.name} — run manually:\n${client.manual()}\n`);
    }
    return;
  }

  if (!client.mergeKey || !client.configPath) {
    console.log(`  ~ ${client.name} — manual setup:\n${client.manual()}\n`);
    return;
  }

  try {
    const existing = readJsonFileSafe(client.configPath) ?? {};
    if (typeof existing[client.mergeKey] !== 'object' || !existing[client.mergeKey]) {
      existing[client.mergeKey] = {};
    }
    existing[client.mergeKey].canvas = { command: 'canvas', args: ['serve'] };
    writeJsonFile(client.configPath, existing);
    let line = `  ✓ ${client.name} — configured`;
    if (client.note) line += `\n    ${client.note}`;
    console.log(line + '\n');
  } catch {
    console.log(`  ~ ${client.name} — auto-configure failed:\n${client.manual()}\n`);
  }
}

function printAllInstructions(clients) {
  console.log('');
  for (const client of clients) {
    console.log(`── ${client.name} ${'─'.repeat(Math.max(0, 42 - client.name.length))}`);
    console.log(client.manual());
    console.log('');
  }
}

function askQuestion(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function runSetup() {
  console.log(`\nCogniboom Canvas v${packageJson.version}\n${'─'.repeat(28)}\n`);

  const clients = getClients();
  const detected = clients.filter(safeDetect);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (!isInteractive) {
    // postinstall or piped — auto-configure detected, print the rest
    if (detected.length > 0) {
      console.log('Configuring detected AI clients:\n');
      for (const client of detected) await configureClientAuto(client);
    } else {
      console.log('No AI clients auto-detected.\n');
    }
    const rest = clients.filter(c => !safeDetect(c));
    if (rest.length > 0) {
      console.log('Other supported clients — add manually:');
      printAllInstructions(rest);
    }
  } else {
    // Interactive terminal
    if (detected.length > 0) {
      console.log(`Detected: ${detected.map(c => c.name).join('  ')}\n`);
      console.log('  [1] Configure detected clients automatically');
      console.log('  [2] Other — view all clients with setup instructions');
      console.log('  [s] Skip\n');

      const ans = await askQuestion('> ');

      if (ans === '1' || ans === '') {
        console.log('');
        for (const client of detected) await configureClientAuto(client);
      } else if (ans === '2') {
        printAllInstructions(clients);
      }
    } else {
      console.log('No AI clients auto-detected.\n');
      console.log('  [1] View all supported clients with setup instructions');
      console.log('  [s] Skip\n');

      const ans = await askQuestion('> ');
      if (ans === '1' || ans === '') printAllInstructions(clients);
    }
  }

  console.log(`Start the server:
  canvas serve    stdio — launched automatically by your AI client
  canvas http     HTTP  — run persistently at ${mcpHttpUrl}

Commands: canvas serve | http | setup | doctor | version
Docs:     ${setupPageUrl}
`);
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
Canvas dir: ${path.join(process.cwd(), '.canvas')}

${portAvailable ? `Start HTTP mode with: ${httpCommand}` : 'If this is not Canvas, stop the process using port 3762 or set CANVAS_PORT.'}`);
}

async function main() {
  if (command === 'serve') {
    const { startStdioMcpServer } = await importScript('scripts/canvas-mcp-server.mjs');
    // Run update check in background. If a new version installs, exit so the
    // MCP client auto-restarts us on the fresh binary.
    checkAndAutoUpdate().then((updated) => {
      if (updated) {
        console.error('[canvas] Restarting to apply update...');
        process.exit(0);
      }
    }).catch(() => {});
    await startStdioMcpServer({ startApp: true, open: false });
    return;
  }

  if (command === 'http') {
    checkAndAutoUpdate().then((updated) => {
      if (updated) console.log('[canvas] Updated. Restart the server to use the new version.');
    }).catch(() => {});
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
    await runSetup();
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
    await runSetup();
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
