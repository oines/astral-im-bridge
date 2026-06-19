import type { AstralAppServerClient } from "./astral.js";
import type { ExternalEventBatcher } from "./event_batcher.js";
import { recentLogs } from "./logger.js";
import type { OneBotClient } from "./onebot.js";
import type { MessageStore } from "./store.js";
import type { BridgeConfig } from "./types.js";

const startedAt = new Date();

export function dashboardState(
  config: BridgeConfig,
  onebot: OneBotClient,
  astral: AstralAppServerClient,
  store: MessageStore,
  eventBatcher?: ExternalEventBatcher,
): Record<string, unknown> {
  return {
    now: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    services: {
      onebot: onebot.status(),
      astral: astral.status(),
      mcp: {
        transport: config.mcp.transport,
        host: config.mcp.host,
        port: config.mcp.port,
        path: config.mcp.path,
      },
      externalEvents: {
        enabled: config.externalEvents.enabled,
        path: config.externalEvents.path,
        schemaPath: `${config.externalEvents.path}/schema`,
        authRequired: Boolean(config.externalEvents.authToken),
        maxBodyBytes: config.externalEvents.maxBodyBytes,
        debounceMs: config.externalEvents.debounceMs,
        maxBatchEvents: config.externalEvents.maxBatchEvents,
        maxBatchBodyChars: config.externalEvents.maxBatchBodyChars,
        batcher: eventBatcher?.status() ?? null,
      },
    },
    routing: {
      fixedThreadId: config.astral.threadId,
      qqBotUserId: config.qq.botUserId,
      allowedGroupIds: config.qq.allowedGroupIds,
      alwaysTriggerGroupIds: config.qq.alwaysTriggerGroupIds,
      allowedPrivateUserIds: config.qq.allowedPrivateUserIds,
      recordUntriggered: config.qq.recordUntriggered,
    },
    conversations: store.conversationSummaries(20),
    recentMessages: store.recentStoredMessages(30),
    logs: recentLogs(120),
  };
}

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Astral Bridge</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #141820;
      --panel-2: #10141a;
      --text: #e8edf2;
      --muted: #8e9aaa;
      --line: #26303c;
      --ok: #3ddc97;
      --warn: #f2c94c;
      --bad: #ff6b6b;
      --accent: #7aa2ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: #0f1217;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 16px; font-weight: 650; }
    main {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      gap: 14px;
      padding: 14px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
    }
    section h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 13px;
      color: var(--muted);
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }
    .stack { display: grid; gap: 14px; align-content: start; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 12px; }
    .metric {
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      min-height: 70px;
    }
    .label { color: var(--muted); font-size: 12px; }
    .value { margin-top: 5px; font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .muted { color: var(--muted); }
    .content { padding: 10px 12px; }
    .row {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .row:last-child { border-bottom: 0; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th { color: var(--muted); font-size: 12px; font-weight: 650; background: var(--panel-2); }
    .wide { display: grid; gap: 14px; min-width: 0; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: var(--panel-2);
      font-size: 12px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); }
    .dot.bad { background: var(--bad); }
    .toolbar { display: flex; align-items: center; gap: 10px; }
    a { color: var(--accent); text-decoration: none; }
    @media (max-width: 1000px) {
      main { grid-template-columns: 1fr; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Astral Bridge</h1>
    <div class="toolbar">
      <span id="refresh" class="pill">refreshing</span>
      <a href="/api/events/schema">event schema</a>
    </div>
  </header>
  <main>
    <div class="stack">
      <section>
        <h2>Status</h2>
        <div class="grid" style="grid-template-columns: 1fr 1fr;">
          <div class="metric"><div class="label">NapCat</div><div id="napcat" class="value">-</div></div>
          <div class="metric"><div class="label">Astral</div><div id="astral" class="value">-</div></div>
          <div class="metric"><div class="label">Active turn</div><div id="turn" class="value">-</div></div>
          <div class="metric"><div class="label">Uptime</div><div id="uptime" class="value">-</div></div>
        </div>
      </section>
      <section>
        <h2>Routing</h2>
        <div id="routing" class="content"></div>
      </section>
      <section>
        <h2>External Events</h2>
        <div id="events" class="content"></div>
      </section>
    </div>
    <div class="wide">
      <section>
        <h2>Recent Conversations</h2>
        <div id="conversations"></div>
      </section>
      <section>
        <h2>Recent Messages</h2>
        <div id="messages"></div>
      </section>
      <section>
        <h2>Recent Logs</h2>
        <div id="logs"></div>
      </section>
    </div>
  </main>
  <script>
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const qs = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    function yes(value) { return value ? '<span class="ok">connected</span>' : '<span class="bad">offline</span>'; }
    function time(value) { return value ? fmt.format(new Date(value)) : ''; }
    function short(value) {
      const text = String(value ?? '');
      return text.length > 80 ? text.slice(0, 77) + '...' : text;
    }
    function table(headers, rows) {
      return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
    }
    async function load() {
      const res = await fetch('/api/dashboard/state', { cache: 'no-store' });
      const state = await res.json();
      qs('refresh').textContent = 'updated ' + time(state.now);
      qs('napcat').innerHTML = yes(state.services.onebot.connected);
      qs('astral').innerHTML = yes(state.services.astral.connected);
      qs('turn').innerHTML = state.services.astral.activeTurnId ? '<span class="warn">' + esc(state.services.astral.activeTurnId) + '</span>' : '<span class="muted">idle</span>';
      qs('uptime').textContent = Math.floor(state.uptimeSeconds / 60) + 'm';
      qs('routing').innerHTML = [
        ['thread', state.routing.fixedThreadId],
        ['bot qq', state.routing.qqBotUserId],
        ['groups', state.routing.allowedGroupIds.join(', ')],
        ['always trigger groups', state.routing.alwaysTriggerGroupIds.join(', ')],
        ['private', state.routing.allowedPrivateUserIds.join(', ')],
      ].map(([k,v]) => '<div class="row"><div class="label">' + esc(k) + '</div><div><code>' + esc(v) + '</code></div></div>').join('');
      qs('events').innerHTML = [
        ['enabled', state.services.externalEvents.enabled],
        ['path', state.services.externalEvents.path],
        ['schema', state.services.externalEvents.schemaPath],
        ['auth required', state.services.externalEvents.authRequired],
        ['pending batch', state.services.externalEvents.batcher ? state.services.externalEvents.batcher.pendingEvents : 0],
        ['dropped batch', state.services.externalEvents.batcher ? state.services.externalEvents.batcher.droppedEvents : 0],
        ['batch window', state.services.externalEvents.debounceMs + 'ms'],
      ].map(([k,v]) => '<div class="row"><div class="label">' + esc(k) + '</div><div><code>' + esc(v) + '</code></div></div>').join('');
      qs('conversations').innerHTML = table(['type', 'target', 'count', 'latest'], state.conversations.map((c) => [
        esc(c.sourceType),
        esc(c.groupName || c.targetId),
        esc(c.messageCount),
        esc(short(c.latestMessage.rawMessage || c.latestMessage.text))
      ]));
      qs('messages').innerHTML = table(['time', 'where', 'sender', 'trigger', 'text'], state.recentMessages.map((m) => [
        esc(time(m.time * 1000)),
        esc((m.groupName || m.targetId) + ' / ' + m.sourceType),
        esc(m.groupCard || m.nickname || m.userId),
        esc(m.trigger),
        esc(short(m.rawMessage || m.text || '[non-text]'))
      ]));
      qs('logs').innerHTML = '<div class="content"><pre>' + esc(state.logs.map((l) => {
        const meta = l.meta === undefined ? '' : ' ' + JSON.stringify(l.meta);
        return '[' + l.ts + '] ' + l.level.toUpperCase() + ' ' + l.message + meta;
      }).join('\\n')) + '</pre></div>';
    }
    load().catch((err) => { qs('refresh').textContent = String(err); });
    setInterval(() => load().catch((err) => { qs('refresh').textContent = String(err); }), 2000);
  </script>
</body>
</html>`;
}
