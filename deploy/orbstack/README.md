# OrbStack Deployment

This directory is intended to be copied to a deployment host as `~/astral-deploy`
or another directory you control.

Services:

- `bridge`: OneBot v11 reverse WebSocket listener, optional Telegram long polling, plus streamable HTTP MCP at `http://bridge:6710/mcp`.
- `astral-code`: Ubuntu-based Astral app-server container. It runs with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`; the container boundary is the isolation layer.
- `napcat`: `mlikiowa/napcat-docker:latest`.

Mapped directories:

- `astral-home/`: Astral config, auth, sessions, and app-server token.
- `astral-bin/`: replaceable Astral binary directory. Put an executable named `astral` here to swap versions without rebuilding.
- `cargo-home/`: Cargo registry/git cache for container-side builds.
- `astral-target/`: Cargo build cache for the Linux Astral binary, kept outside the source tree.
- `workspace/`: agent workspace mounted at `/workspace`.
- `bridge/data/` and `bridge/media/`: QQ/Telegram history DB and downloaded media.
- `napcat/config/` and `napcat/ntqq/`: NapCat and QQ state.

NapCat reverse WebSocket target:

```text
ws://bridge:6701/onebot/v11/ws
```

Telegram is disabled by default. To enable it, set `TELEGRAM_ENABLED=true`,
`TELEGRAM_BOT_TOKEN`, and allowlisted `TELEGRAM_ALLOWED_CHAT_IDS` in `.env`. Send
`/chatid` to the Telegram bot to retrieve the current chat id before adding it to the
allowlist.

Start:

```bash
docker compose --env-file .env -f compose.yml up -d --build
```

The default `.env.example` binds published ports to `127.0.0.1`. If you intentionally set
`PUBLISH_HOST=0.0.0.0`, NapCat WebUI is reachable from the LAN at:

```text
http://<host-ip>:6099/webui?token=<token-from-napcat-logs>
```
