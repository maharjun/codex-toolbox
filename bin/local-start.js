#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launcherEnv, localPaths } from '../src/local-runtime.js';

try {
  const configPath = process.argv[2] || localPaths().config;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  Object.assign(process.env, launcherEnv(config, {
    proxyPath: fileURLToPath(new URL('./local-codex-proxy.js', import.meta.url)),
  }));
} catch {
  console.error('Cannot start bridge. Activate your secrets environment and check config.json (numeric userId, absolute cwd, optional codexEndpoint). See PORTABLE_SETUP.md.');
  process.exit(1);
}
await import('./codex-toolbox.js');
