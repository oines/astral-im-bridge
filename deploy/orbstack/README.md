# Docker / OrbStack 部署文档

这份目录是 `astral-bridge` 的 Docker 部署模板，主要面向 macOS + OrbStack，也可以用在普通 Docker Compose 主机上。它会启动三类服务：

- `bridge`：接收 QQ/NapCat OneBot 反向 WebSocket、可选 Telegram long polling，并暴露 HTTP MCP。
- `astral-code`：运行 Astral app-server，所有白名单内的 IM 触发都会进入同一个固定 Astral thread。
- `napcat`：运行 NapCat QQ 协议端，并把 OneBot 事件推给 `bridge`。

## 目录结构

建议把本目录复制到部署机上的一个固定目录，例如：

```bash
mkdir -p ~/project/astral-deploy
cp -a deploy/orbstack/. ~/project/astral-deploy/
cd ~/project/astral-deploy
```

部署目录里建议保留这些持久化目录：

```text
astral-home/        Astral 配置、登录态、thread/session、app-server token
astral-bin/         可替换的 astral 可执行文件，文件名必须是 astral
astral-code-src/    Astral 源码；没有 astral-bin/astral 时容器会从源码构建
cargo-home/         Rust/Cargo registry 和 git 缓存
astral-target/      Rust 构建产物缓存，避免每次重建都全量编译
workspace/          Agent 工作区，容器内路径是 /workspace
bridge/config/      bridge.json 配置文件
bridge/data/        bridge SQLite 历史消息数据库
bridge/media/       bridge 下载的 QQ/TG 媒体文件
napcat/config/      NapCat 配置
napcat/ntqq/        QQ 登录态和 NTQQ 数据
```

这些目录都应该放在 Compose 项目目录下，不要放到容器内临时层里，否则重建容器后会丢状态。

## 初始化文件

复制环境变量模板：

```bash
cp .env.example .env
```

创建 bridge 配置目录：

```bash
mkdir -p bridge/config
cp bridge.config.json bridge/config/bridge.json
```

准备 bridge 构建源码。`compose.yml` 默认从 `./astral-bridge-src` 构建 `bridge` 镜像，所以部署目录里必须有一份项目源码：

```bash
mkdir -p astral-bridge-src
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  --exclude media \
  /path/to/astral-bridge/ \
  astral-bridge-src/
```

之后每次更新 bridge 代码，都重新同步这份源码再执行 build。

创建 Astral 配置目录：

```bash
mkdir -p astral-home
cp astral-config.toml astral-home/config.toml
```

创建工作区和外部事件 API 凭据文件：

```bash
mkdir -p workspace
cat > workspace/.bridge-event-api.env <<'EOF'
ASTRAL_BRIDGE_EVENT_API_URL=http://bridge:6710/api/events
ASTRAL_BRIDGE_EVENT_API_TOKEN=把这里替换成 .env 里的 ASTRAL_BRIDGE_EVENT_API_TOKEN
EOF
chmod 600 workspace/.bridge-event-api.env
```

这个文件是给容器内 agent 或脚本读取的，不要提交到 Git。

如果你希望容器启动时从源码构建 Astral，需要把 Astral 源码放到：

```text
astral-code-src/
```

源码目录里应包含 `codex-rs/`。如果你已经有 Linux 可执行文件，也可以直接放：

```text
astral-bin/astral
```

并确保它可执行。

## 必填环境变量

编辑 `.env`，至少需要配置这些值：

```env
ASTRAL_THREAD_ID=固定的 Astral thread id
ASTRAL_APP_SERVER_TOKEN=长随机 token，用于 bridge 连接 astral-code app-server
ASTRAL_BRIDGE_EVENT_API_TOKEN=长随机 token，用于外部事件 API

QQ_BOT_ID=机器人 QQ 号
QQ_ALLOWED_GROUP_IDS=允许访问 bot 的 QQ 群号，多个用逗号分隔
QQ_ALLOWED_PRIVATE_USER_IDS=允许私聊 bot 的 QQ 用户号，多个用逗号分隔
```

如果使用 OpenAI 或兼容提供商，还需要配置对应 key：

```env
OPENAI_API_KEY=...
ASTRAL_API_KEY=...
```

具体使用哪个变量取决于你的 Astral/provider 配置。不要把 `.env` 提交到仓库。

如果希望由 bridge 配置固定 thread 使用的模型，可以加：

```env
ASTRAL_MODEL_PROVIDER=mimo
ASTRAL_MODEL=mimo-v2.5
```

这两个值只负责告诉 bridge 发起 turn 时选哪个 provider/model；provider 本身、API key、能力声明仍由 `astral-home/config.toml` 管理。

## 端口

默认 `.env.example` 里：

```env
PUBLISH_HOST=127.0.0.1
```

这表示端口只暴露到部署机本机。常用端口：

```text
6701  bridge OneBot 反向 WebSocket
6710  bridge HTTP MCP / Web UI / 外部事件 API
4222  Astral app-server WebSocket
3001  NapCat WebUI
6099  NapCat HTTP/WebUI 相关端口
```

如果你确实要让局域网访问这些端口，可以改成：

```env
PUBLISH_HOST=0.0.0.0
```

这样做之前请确认局域网可信，并且不要把 NapCat WebUI、bridge MCP、Astral app-server 暴露到公网。

## 启动

```bash
docker compose --env-file .env -f compose.yml up -d --build
```

查看状态：

```bash
docker compose --env-file .env -f compose.yml ps
```

查看日志：

```bash
docker compose --env-file .env -f compose.yml logs -f bridge
docker compose --env-file .env -f compose.yml logs -f astral-code
docker compose --env-file .env -f compose.yml logs -f napcat
```

健康检查：

```bash
curl -fsS http://127.0.0.1:6710/healthz
```

Web UI：

```text
http://127.0.0.1:6710/ui
```

## NapCat 配置

NapCat 登录后，在 WebUI 里新增 OneBot v11 WebSocket 客户端，反向连接地址填：

```text
ws://bridge:6701/onebot/v11/ws
```

如果你从宿主机或其他机器访问 NapCat WebUI，地址通常是：

```text
http://127.0.0.1:6099/webui?token=<从 napcat 日志里看到的 token>
```

如果 `PUBLISH_HOST=0.0.0.0`，可以用：

```text
http://<部署机 IP>:6099/webui?token=<token>
```

确认 bridge 日志里出现：

```text
napcat connected
```

表示 NapCat 已经连上。

## QQ 白名单和触发

QQ 相关环境变量：

```env
QQ_BOT_ID=机器人 QQ 号
QQ_ALLOWED_GROUP_IDS=群号1,群号2
QQ_ALWAYS_TRIGGER_GROUP_IDS=
QQ_ALLOWED_PRIVATE_USER_IDS=用户QQ1,用户QQ2
QQ_TRIGGER_KEYWORDS=astral
```

规则：

- 群聊和私聊都必须先在白名单里，否则 bridge 会忽略。
- 私聊白名单内默认触发。
- 群聊默认在 at bot、回复 bot、命中关键词、或配置为 always trigger 时触发。
- `QQ_TRIGGER_KEYWORDS` 可以写多个，逗号分隔，不区分大小写，命中包含关系即触发。
- `/stop` 在白名单内可中断当前 Astral turn。
- QQ 戳一戳事件也会触发：群聊/私聊白名单内，且被戳对象是 bot 时，bridge 会生成 `group_poke` 或 `private_poke` 入站事件。

未触发但来自白名单会话的消息默认会存进 SQLite，方便 Astral 后续用 MCP 工具拉历史。

## Telegram 配置

Telegram 默认关闭。开启时配置：

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=BotFather 给的 token
TELEGRAM_BOT_USERNAME=bot username，可带 @ 也可不带
TELEGRAM_ALLOWED_CHAT_IDS=6995308224,-100xxxxxxxxxx
TELEGRAM_ALWAYS_TRIGGER_CHAT_IDS=
TELEGRAM_TRIGGER_KEYWORDS=astral
```

获取 chat id：

1. 先启动服务。
2. 给 Telegram bot 发送 `/chatid`。
3. bridge 会回复当前 `chat_id`、`chat_type`、群名、用户 id 等。
4. 把需要允许的 `chat_id` 写进 `TELEGRAM_ALLOWED_CHAT_IDS`。
5. 重启 bridge。

Telegram 使用 long polling。bridge 启动时会调用 `deleteWebhook`，确保 `getUpdates` 能正常工作。

## Bridge 配置

`bridge/config/bridge.json` 是基础配置，`.env` 里的同名环境变量会覆盖它。模板里已经配置为：

```json
{
  "mcp": {
    "transport": "http",
    "host": "0.0.0.0",
    "port": 6710,
    "path": "/mcp"
  },
  "astral": {
    "appServerUrl": "ws://astral-code:4222",
    "cwd": "/workspace",
    "modelProvider": null,
    "model": null,
    "includeImageInputs": false
  },
  "storage": {
    "dbPath": "/app/data/astral-bridge.db",
    "mediaDir": "/app/media",
    "downloadMedia": true
  }
}
```

重点：

- `astral.cwd` 应保持为 `/workspace`，这样 Astral 的工作区、文件生成、记忆文件都在持久化挂载里。
- `ASTRAL_MODEL_PROVIDER` / `ASTRAL_MODEL` 可在 `.env` 中覆盖 bridge 发起的新 turn 模型；bridge 恢复固定 thread 后也会同步一次 thread settings。对应的 provider 和 API key 仍需先在 `astral-home/config.toml` 里配置好。
- `storage.dbPath` 和 `storage.mediaDir` 已经映射到 `bridge/data` 和 `bridge/media`，重建 bridge 不会丢历史和媒体。
- `includeImageInputs=false` 是推荐默认值：入站图片只作为附件元数据进入上下文，agent 需要查看时再用 MCP 下载，避免 QQ/TG 临时 URL 过期或需要鉴权时污染长期会话。只有确认图片 URL 对模型长期稳定可访问时才建议打开。

## Astral 配置

`astral-home/config.toml` 控制 Astral app-server 的默认行为。模板内容类似：

```toml
model = "gpt-5-codex"
model_provider = "openai"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[mcp_servers.qq]
url = "http://bridge:6710/mcp"

[mcp_servers.telegram]
url = "http://bridge:6710/mcp"
```

这个部署把 Astral 放在 Docker 容器里运行，外层容器边界是主要隔离层。`sandbox_mode = "danger-full-access"` 表示 Astral turn 内部不再额外套一层文件系统 sandbox。不要把宿主机敏感目录挂进 `/workspace`。

MCP endpoint 可以注册两次，分别叫 `qq` 和 `telegram`。这样工具名会更自然，例如：

```text
mcp__qq__qq_send_group_message
mcp__telegram__telegram_send_message
mcp__telegram__telegram_send_rich_message
```

## 记忆配置

记忆相关文件应放在 `/workspace` 下，因为 `workspace/` 是持久化挂载。推荐目录：

```text
/workspace/.astral/memories/
```

也就是宿主机上的：

```text
./workspace/.astral/memories/
```

建议提前创建：

```bash
mkdir -p workspace/.astral/memories
```

这样容器重建、镜像重建、bridge 重启都不会丢记忆。

如果你的 Astral 分支支持 memory phase2 sandbox 开关，可以在 `astral-home/config.toml` 顶层配置：

```toml
# 默认行为，phase2 仍使用 workspace-write sandbox。
# phase2_sandbox = "workspace_write"

# 如果 Docker 容器没有 SYS_ADMIN / seccomp=unconfined，而 phase2 的 Linux sandbox 跑不起来，
# 可以在确认容器外层隔离足够后开启：
phase2_sandbox = "danger_full_access"
```

含义：

- `workspace_write`：默认更保守，phase2 记忆整理仍走 workspace-write sandbox。
- `danger_full_access`：关闭 phase2 内层 sandbox，适合外层已经由 Docker 隔离、且不想给容器加特权能力的部署。

即使 phase2 使用 `danger_full_access`，仍建议保留这些约束：

- `cwd` 仍是 `/workspace`。
- 记忆目录仍在 `/workspace/.astral/memories`。
- 不给容器挂载宿主机敏感目录。
- 不把 Docker socket、SSH key、浏览器 cookie、生产密钥目录挂进容器。

如果你不开这个开关，又发现记忆整理 phase2 卡住或无法落盘，优先检查：

```bash
docker compose --env-file .env -f compose.yml logs -f astral-code
```

然后确认 `workspace/.astral/memories` 是否有文件更新，而不是只看 turn 是否显示 done。

## MCP 和消息发送

bridge 的 HTTP MCP 地址：

```text
http://bridge:6710/mcp
```

Astral 必须通过 MCP 工具把消息发回 QQ/TG。普通 assistant 文本不会自动发送到任何 IM，这是刻意设计。

常用能力：

- QQ/TG 发文本、回复消息、发文件。
- QQ 群 @ 人。
- Telegram username/user_id mention。
- QQ 群 reaction。
- Telegram 群聊/私聊 reaction。
- Telegram 删除消息。
- QQ 撤回/群管理/群文件等管理工具。
- 拉未读消息、历史消息、搜索消息、下载媒体。

bridge 会把入站消息存入 SQLite；MCP 历史工具返回的是精简结构，包含 `message_id`、发送者、文本、reply 关系和附件摘要，方便 agent 看懂。

## 外部事件 API

bridge 默认开启外部事件 API：

```text
POST http://bridge:6710/api/events
```

容器内 agent 可以读：

```text
/workspace/BRIDGE_EVENT_API.md
/workspace/.bridge-event-api.env
```

其中 `.bridge-event-api.env` 需要在初始化时创建，token 应与 `.env` 里的 `ASTRAL_BRIDGE_EVENT_API_TOKEN` 一致。

外部调用需要带：

```http
Authorization: Bearer <ASTRAL_BRIDGE_EVENT_API_TOKEN>
```

查看 schema：

```bash
curl -fsS http://127.0.0.1:6710/api/events/schema
```

普通 assistant 文本仍不会自动发到 QQ/TG；外部事件需要通知聊天用户时，Astral 也必须调用 QQ/TG MCP send 工具。

## 安全建议

- 默认保持 `PUBLISH_HOST=127.0.0.1`。
- 不要把 NapCat WebUI、bridge MCP、Astral app-server 暴露到公网。
- `ASTRAL_APP_SERVER_TOKEN` 和 `ASTRAL_BRIDGE_EVENT_API_TOKEN` 用长随机值。
- `.env`、`astral-home/`、`napcat/ntqq/`、`bridge/data/` 不要提交到 Git。
- 不要挂载 Docker socket。
- 不要挂载宿主机家目录、SSH key、浏览器数据目录、生产密钥目录。
- 如果使用 `phase2_sandbox = "danger_full_access"`，更要保证容器挂载边界干净。

## 常用维护命令

重启 bridge：

```bash
docker compose --env-file .env -f compose.yml restart bridge
```

重启 Astral，让 MCP 工具/schema 重新加载：

```bash
docker compose --env-file .env -f compose.yml restart astral-code
```

重建 bridge：

```bash
docker compose --env-file .env -f compose.yml build bridge
docker compose --env-file .env -f compose.yml up -d bridge
docker compose --env-file .env -f compose.yml restart astral-code
```

查看 bridge 健康状态：

```bash
curl -fsS http://127.0.0.1:6710/healthz
```

查看近期 bridge 日志：

```bash
docker compose --env-file .env -f compose.yml logs --tail=100 bridge
```

备份数据：

```bash
tar czf astral-bridge-backup.tgz \
  .env \
  astral-home \
  workspace/.astral \
  bridge/data \
  bridge/media \
  napcat/config \
  napcat/ntqq
```

更新 bridge 源码后部署：

```bash
docker compose --env-file .env -f compose.yml build bridge
docker compose --env-file .env -f compose.yml up -d bridge
docker compose --env-file .env -f compose.yml restart astral-code
```

## 排障

NapCat 没连上：

- 检查 NapCat WebSocket 目标是否是 `ws://bridge:6701/onebot/v11/ws`。
- 看 `bridge` 日志是否出现 `napcat connected`。
- 确认 `bridge` 和 `napcat` 在同一个 compose project 网络里。

QQ 群里不触发：

- 确认群号在 `QQ_ALLOWED_GROUP_IDS` 或 `QQ_ALWAYS_TRIGGER_GROUP_IDS`。
- 普通群消息默认不触发，除非 at bot、回复 bot、命中关键词或 always trigger。
- 如果是戳一戳，确认被戳对象是 bot。

Telegram 不触发：

- 先用 `/chatid` 获取准确 chat id。
- 写入 `TELEGRAM_ALLOWED_CHAT_IDS` 后重启 bridge。
- 群聊里如果 privacy mode 开着，Telegram bot 只能收到命令、at、回复等消息；需要在 BotFather 调整 privacy，或只依赖 at/回复触发。

Astral 没发回 IM：

- 这是预期边界：普通 assistant 文本不会自动转发。
- Astral 必须调用 QQ/TG MCP send/reaction/file 工具。
- 修改 MCP 工具或 bridge 代码后，需要重启 `astral-code`，让工具 schema 重新加载。

记忆没更新：

- 看 `workspace/.astral/memories` 是否真的有文件修改。
- 看 `astral-code` 日志是否有 phase2/sandbox 错误。
- 如果容器没有额外特权且 phase2 sandbox 跑不起来，可以考虑 `phase2_sandbox = "danger_full_access"`。
