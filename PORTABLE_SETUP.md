# Windows and POSIX setup

The Telegram bridge uses Node.js on both platforms. Python, systemd, and a fixed installation directory are not required. Run `npm ci` in the checkout. Node 24 is the tested version.

## One shared Codex server

For a common Windows/POSIX workflow, run these in separate terminals:

```text
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
```

Launch additional Codex terminals against the same endpoint for additional conversations. This is an explicit shared-server workflow: it does not move existing sessions out of other running app-server processes or bypass writer locks. Verify `--remote` and WebSocket support in your installed Codex version before using this workflow. The upstream WebSocket transport is experimental.

Reference: https://learn.chatgpt.com/docs/app-server

The existing POSIX daemon workflow still works unchanged. Without an explicit endpoint the proxy uses the existing Unix control socket on POSIX, and `ws://127.0.0.1:4500/` on Windows.

## Configure

Create a config file outside the checkout containing your numeric Telegram user ID, workspace directory, and shared server endpoint. Example for Windows (replace the example values):

```json
{
  "userId": 123456789,
  "cwd": "C:\\Work\\my-project",
  "codexEndpoint": "ws://127.0.0.1:4500"
}
```

On POSIX, use an absolute POSIX workspace path. Omit `codexEndpoint` to keep using the existing POSIX daemon socket.

Default config locations:
- Windows: `%LOCALAPPDATA%\codex-toolbox\config.json` (falls back to the user's AppData\Local directory).
- POSIX: `~/.config/codex-toolbox/config.json`.

Default state locations:
- Windows: `%LOCALAPPDATA%\codex-toolbox\state.json`.
- POSIX: `~/.local/state/codex-toolbox/state.json`.

`CODEX_TOOLBOX_CONFIG` and `CODEX_TOOLBOX_STATE` override these paths. An explicit config filename can also be passed to the launcher.

## Start and stop

Activate your existing secrets environment first. The launcher consumes `TELEGRAM_BOT_API_KEY` and maps it to the bridge's token variable in process memory. No token belongs in the config file. `TELEGRAM_BOT_URL` is not needed to send messages and cannot identify the destination group or your user ID.

From the checkout, use the same command in PowerShell or a POSIX shell:

```text
node bin/local-start.js
```

Or supply an explicit config path:

```text
node bin/local-start.js "path to config.json"
```

The bridge runs in the foreground; Ctrl+C stops it. Restart by running the same command again. An OS-specific background supervisor is optional and must receive the secrets environment without persisting credentials. The existing Linux service can continue to call this launcher.

Only one bridge should consume updates for a given Telegram bot. Do not start this Windows instance while Linux is polling the same bot. Arrange a takeover first, use separate bots, or implement a shared receiver for concurrent hosts. This launcher does not coordinate ownership across machines.

The bot must have permission to manage topics in the destination forum supergroup. Use `/bind` there with the allowed Telegram account. State is local to the bridge; do not assume another machine's thread mappings refer to your local Codex sessions.

## Transport overrides

- `CODEX_APP_SERVER_URL` overrides the configured endpoint. Supports loopback `ws://` and remote `wss://`; embedded URL credentials are rejected.
- `CODEX_APP_SERVER_TOKEN`, if required by your server, is sent as a bearer header and consumed only from the environment. Do not put it in config or command arguments.
- `CODEX_CONTROL_SOCKET` overrides the POSIX Unix socket path.
- `CODEX_HOME` overrides the default POSIX Codex directory.

The proxy disables WebSocket compression and launches via the running Node executable with a JSON argument array, preserving Windows paths containing spaces. No shell invocation is required.

## Verification

Run the focused suite, including platform-path cases and a real local TCP WebSocket proxy test:

```text
node --test --test-isolation=none test/local-runtime.test.js test/telegram-markdown.test.js test/telegram.test.js test/bridge.test.js test/codex-app-server.test.js test/state.test.js test/index.test.js test/json-rpc-client.test.js
```

Then test two conversations, a topic reply, a structured question, `/rename`, Markdown, silent progress, and one completion alert. Windows path behavior is tested on Linux; native Windows execution and attachment must still be verified on Windows.
