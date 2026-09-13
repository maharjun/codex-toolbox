#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const config = JSON.parse(readFileSync(`${homedir()}/.config/codex-toolbox/config.json`, 'utf8'));
if (!process.env.TELEGRAM_BOT_API_KEY) {
  console.error('Activate your secrets environment, then run codex-telegram-start.');
  process.exit(1);
}
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_API_KEY,
  TELEGRAM_ALLOWED_USER_IDS: String(config.userId),
  CODEX_SYNC_PROVIDER: 'telegram',
  CODEX_TOOLBOX_STATE: `${homedir()}/.local/state/codex-toolbox/state.json`,
  CODEX_APP_SERVER_COMMAND: process.execPath,
  CODEX_APP_SERVER_ARGS: `${homedir()}/.local/share/codex-toolbox/bin/local-codex-proxy.js`,
  CODEX_APP_SERVER_CWD: config.cwd,
  CODEX_TELEGRAM_MESSAGE_SCOPE: 'conversation',
});
await import('./codex-toolbox.js');
