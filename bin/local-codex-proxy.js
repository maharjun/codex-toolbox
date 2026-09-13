#!/usr/bin/env node
// Adapt Toolbox's JSONL client to the shared Codex daemon's local WebSocket.
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const socket = process.env.CODEX_CONTROL_SOCKET || join(process.env.CODEX_HOME || homedir() + '/.codex', 'app-server-control/app-server-control.sock');
const ws = new WebSocket(`ws+unix://${socket}:/rpc`, { perMessageDeflate: false });
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
