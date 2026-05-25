#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const dist = path.join(packageRoot, 'dist');

if (fs.existsSync(dist)) process.exit(0);

const repoPackageJsonPath = path.join(repoRoot, 'package.json');
try {
  const pkg = JSON.parse(fs.readFileSync(repoPackageJsonPath, 'utf8'));
  if (pkg.name === 'canvas-app' && pkg.scripts?.['build:mcp-package']) {
    console.log('[canvas] Building frontend...');
    execSync('npm run build:mcp-package', { cwd: repoRoot, stdio: 'inherit' });
  }
} catch {
  // Not in monorepo or build failed — dist will be absent, server falls back gracefully
}
