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

## Diagnose notification delivery

Set `CODEX_TELEGRAM_TRACE_DELIVERY=1` in the launch environment to enable opt-in diagnostics. The bridge logs each send/edit attempt and acceptance/failure, the requested silent flag, a hashed destination, and Telegram's returned message ID. Completion receipt and duplicate suppression are logged separately. No message body, token, API URL, conversation title, raw chat ID, or server error description is included in these records. Other pre-existing application logs have their own behavior.

`silent: true` requests silent delivery; `silent: false` requests a normal alert. Edits have `silent: null` because edits cannot request a new alert. An accepted API request does not prove that a phone displayed a notification or played a sound. Turn tracing off by removing the variable or setting it to `0` and restarting.

## User-message mirroring

The portable launcher streams new assistant messages to topics by default, whether
input came from the computer or Telegram. Completed progress messages and final
answers are forwarded; individual token deltas are not sent. New topic mappings
start at the current end of the session log and never replay old history.

Send /pause to the bot (in private chat or the bound group) to stop transcript
streaming for all conversations managed by this bridge. Send /resume to stream
new messages from that point onward, without replaying the paused interval.
Completion alerts, questions, approval controls, and Telegram replies continue to
work while streaming is paused. The pause setting persists across bridge restarts.
Private chat carries alerts/commands; conversation replies belong in group topics.
The former afk message-scope value is treated as conversation for compatibility;
message origin no longer determines whether an answer is forwarded.

### Rename and clean up topics

- `/rename New name` inside a mapped topic renames the Codex conversation and its
  Telegram topic. Names changed in Codex also sync to Telegram. Renaming a topic
  through Telegram's own UI does not rename Codex; mappings use IDs, not names.
- For one topic, send `/unlink` inside it and wait for confirmation before deleting
  the topic in Telegram. This removes only the link; your Codex conversation stays
  on the computer. New activity can create a fresh topic, so unlink is not a mute.
- If you manually delete a linked topic, the bridge recreates it when a delivery
  or rename receives Telegram's explicit missing-topic error. It saves the new
  mapping and retries the operation once. Concurrent failures share a single
  replacement, and replies there continue the same Codex conversation. No old
  transcript is replayed by recovery.
- Private completion alerts check their destination topic before including a link, so
  completion alerts also recover deleted topics even without transcript mirroring.
  The check uses `editForumTopic` without name/icon changes (see the
  [Telegram API](https://core.telegram.org/bots/api#editforumtopic)).
- Network failures, permission errors, rate limits, and closed topics do not
  trigger recreation. If creation fails, the error is recorded and new activity
  can retry. Manual fallback: create a replacement and send `/relink <threadId>`;
  `/topics` lists mapped IDs. Recovery preserves the Codex conversation, not the
  deleted Telegram messages or old topic links.
- `/delete_all_topics confirm` deletes every topic mapped by this bridge and
  removes successful mappings, without deleting Codex conversations. Activity can
  recreate topics. Failed deletions retain their mappings; check the command result.
- Archiving/deleting a conversation in Codex does not automatically delete its
  Telegram topic. The bridge does not implement automatic cleanup for that direction.

Streaming changes apply to future delivery. Existing Telegram history is not removed.

Environment-based startup omits user messages from the Telegram transcript by default, for both live events and session logs. Agent messages, completion alerts, and input/approval requests remain enabled. Replies sent from Telegram still reach Codex. Set `CODEX_TELEGRAM_MIRROR_USER_MESSAGES=1` only if you want user messages mirrored again.

## Private attention alerts

The portable launcher sends completion, question, and approval alerts to the private bot chat of the configured `userId` on Windows and POSIX. Open that bot chat and press Start once before using alerts. Alerts show the current conversation name and a link to its group topic. Transcript messages remain silent in the group; silent messages can still appear in Telegram notifications. User messages are not mirrored by default.

Answer questions and use approval buttons in the linked topic. Confidential input must still be entered in the terminal. Private chat replies are not routed to Codex conversations.

For direct `src/index.js` startup, set `TELEGRAM_ALERT_CHAT_ID` to the intended private chat ID to enable this routing; without it alerts stay in the group. The local launcher derives it from `config.json` automatically.
