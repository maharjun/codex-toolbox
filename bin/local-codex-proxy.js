#!/usr/bin/env node
// Adapt Toolbox's JSONL client to a shared Codex WebSocket on Windows or POSIX.
import { createInterface } from 'node:readline';
import { proxyEndpoint } from '../src/local-runtime.js';
import WebSocket from 'ws';
let endpoint;
try { endpoint = proxyEndpoint(); } catch { console.error('Invalid Codex endpoint configuration.'); process.exit(1); }
const ws = new WebSocket(endpoint, {
  perMessageDeflate: false,
  ...(process.env.CODEX_APP_SERVER_TOKEN ? { headers: { Authorization: `Bearer ${process.env.CODEX_APP_SERVER_TOKEN}` } } : {}),
});
const pending = [];
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (!line.trim()) return;
  if (ws.readyState === WebSocket.OPEN) ws.send(line);
  else pending.push(line);
});
ws.on('open', () => { for (const line of pending.splice(0)) ws.send(line); });
ws.on('message', data => process.stdout.write(`${data.toString()}\n`));
ws.on('error', () => { console.error('Shared Codex daemon connection failed.'); process.exit(1); });
ws.on('close', () => process.exit(0));
input.on('close', () => ws.close());
