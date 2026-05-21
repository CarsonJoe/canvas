import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceDist = path.join(repoRoot, 'dist');
const targetDist = path.join(repoRoot, 'packages', 'canvas-mcp', 'dist');
const targetServer = path.join(repoRoot, 'packages', 'canvas-mcp', 'server');
const serverFiles = [
  ['canvas-local-core.mjs', 'canvas-local-core.mjs'],
  ['canvas-app-server.mjs', 'canvas-app-server.mjs'],
  ['canvas-mcp-server.mjs', 'canvas-mcp-server.mjs'],
];

async function copyDir(source, target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

await fs.access(path.join(sourceDist, 'index.html'));
await copyDir(sourceDist, targetDist);
await fs.rm(targetServer, { recursive: true, force: true });
await fs.mkdir(targetServer, { recursive: true });
for (const [sourceName, targetName] of serverFiles) {
  await fs.copyFile(path.join(repoRoot, 'scripts', sourceName), path.join(targetServer, targetName));
}
console.log(`Copied ${sourceDist} to ${targetDist}`);
