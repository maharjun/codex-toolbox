# Local Telegram setup

Installed from yhdesai/codex-toolbox at 3ede73a, with local compatibility changes:

- Adapt JSONL to the shared Codex daemon's Unix WebSocket transport, disabling compression.
- Rename Codex first; propagate failures and synchronize Telegram topic names from Codex metadata/events.
- Scope topic input routing to the bound Telegram group.
- Deliver approval requests in conversation-only mirroring mode.

Start after activating the environment that decrypts your secrets:

```sh
codex-telegram-start
```

The launcher imports TELEGRAM_BOT_API_KEY into the user service manager's runtime environment. It does not save the API key to a new file. Repeat after reboot/login because this runtime environment is not persisted.

Service commands:

```sh
systemctl --user is-active codex-telegram.service
systemctl --user restart codex-telegram.service
systemctl --user stop codex-telegram.service
```

The service is installed but is not enabled for automatic login startup, since it requires your decrypted environment first.

Configuration: ~/.config/codex-toolbox/config.json
State: ~/.local/state/codex-toolbox/state.json
Both contain pairing/session identifiers and are private to your account.

Telegram: /topics lists mapped conversations. /rename inside a topic changes the Codex name. Ordinary topic messages go to that conversation. /new --cwd /absolute/path Title creates a conversation explicitly in that directory. The upstream project picker defaults to the author's directory layout; prefer explicit --cwd.

Validation: 88 focused Telegram, bridge, transport-client, configuration, and state tests passed. The full upstream suite has existing Discord failures. The local daemon initialization and metadata listing were verified without printing conversation content.

Current upstream limitations: Markdown is converted to Telegram HTML for new messages and streaming edits. Bold, italics, strikethrough, links, blockquotes, and code are rendered; headings use bold and tables use preformatted text. Long messages are split after parsing and each chunk retains balanced tags. Telegram formatting rejections fall back to rendered plain text. A live Telegram send/edit validated the supported formatting entities. Structured user-input requests are relayed as sequential questions; reply with text or an option number. Confidential questions stay in the terminal. Ordinary final-response questions can also be answered with a topic message. Existing sessions owned by another app-server process may not be attachable; this installation does not override their writer locks.

Notification policy: Telegram sends default to disable_notification=true. Progress, streamed answers, transcript mirrors, debug messages, and command acknowledgements are silent. Each completed turn sends one normal completion alert, including in conversation scope. Approvals and structured input requests also alert. Completion events from app-server and session logs are deduplicated by thread and turn ID within five minutes; legacy events without turn IDs use a ten-second fallback. Only the first chunk of an alert can notify; overflow from edits is always silent. Telegram silent delivery suppresses sound but may still display a notification. User chat/topic notification settings still apply.
