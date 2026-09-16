import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function localPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const root = platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'codex-toolbox')
    : null;
  return {
    config: env.CODEX_TOOLBOX_CONFIG || (root ? path.join(root, 'config.json') : path.join(home, '.config', 'codex-toolbox', 'config.json')),
    state: env.CODEX_TOOLBOX_STATE || (root ? path.join(root, 'state.json') : path.join(home, '.local', 'state', 'codex-toolbox', 'state.json')),
  };
}

export function proxyEndpoint({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (env.CODEX_APP_SERVER_URL) {
    let url;
    try { url = new URL(env.CODEX_APP_SERVER_URL); } catch { throw new Error('Invalid CODEX_APP_SERVER_URL.'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('CODEX_APP_SERVER_URL must be a WebSocket URL without embedded credentials.');
    }
    if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Use wss:// for remote Codex connections or ws:// on loopback.');
    }
    return url.href;
  }
  if (platform === 'win32') return 'ws://127.0.0.1:4500/';
  const socket = env.CODEX_CONTROL_SOCKET || posix.join(env.CODEX_HOME || posix.join(home, '.codex'), 'app-server-control', 'app-server-control.sock');
  return `ws+unix://${socket}:/rpc`;
}

export function launcherEnv(config, { env = process.env, platform = process.platform, home = homedir(), execPath = process.execPath, proxyPath } = {}) {
  if (!env.TELEGRAM_BOT_API_KEY) throw new Error('Activate your secrets environment before starting the bridge.');
  const path = platform === 'win32' ? win32 : posix;
  if (!config || !/^\d+$/.test(String(config.userId ?? '')) || !config.cwd || !path.isAbsolute(config.cwd)) {
    throw new Error('Configuration requires a numeric userId and an absolute cwd.');
  }
  const result = {
    ...env,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_API_KEY,
    TELEGRAM_ALLOWED_USER_IDS: String(config.userId),
    TELEGRAM_ALERT_CHAT_ID: String(config.userId),
    CODEX_SYNC_PROVIDER: 'telegram',
    CODEX_TOOLBOX_STATE: localPaths({platform, home, env}).state,
    CODEX_APP_SERVER_COMMAND: execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([proxyPath]),
    CODEX_APP_SERVER_CWD: config.cwd,
    CODEX_TELEGRAM_MESSAGE_SCOPE: env.CODEX_TELEGRAM_MESSAGE_SCOPE || 'afk',
  };
  if (!result.CODEX_APP_SERVER_URL && config.codexEndpoint) result.CODEX_APP_SERVER_URL = config.codexEndpoint;
  // Validate before the bridge starts polling Telegram.
  proxyEndpoint({platform, home, env: result});
  return result;
}

export function parseAppServerArgs(env) {
  if (env.CODEX_APP_SERVER_ARGS_JSON !== undefined) {
    let args;
    try { args = JSON.parse(env.CODEX_APP_SERVER_ARGS_JSON); } catch { throw new Error('CODEX_APP_SERVER_ARGS_JSON must be a JSON string array.'); }
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('CODEX_APP_SERVER_ARGS_JSON must be a JSON string array.');
    return args;
  }
  return (env.CODEX_APP_SERVER_ARGS || 'app-server proxy').match(/(?:[^\s"]+|"[^"]*")+/g)?.map(part => part.replace(/^"|"$/g, '')) ?? [];
}
