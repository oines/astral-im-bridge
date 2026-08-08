import type { AstralAppServerClient } from "./astral.js";
import type { ExternalEventBatcher } from "./event_batcher.js";
import { recentLogs } from "./logger.js";
import type { OneBotClient } from "./onebot.js";
import type { TelegramClient } from "./telegram.js";
import type { BridgeConfig } from "./types.js";

const startedAt = new Date();

export function dashboardState(
  config: BridgeConfig,
  onebot: OneBotClient,
  telegram: TelegramClient | null,
  astral: AstralAppServerClient,
  eventBatcher?: ExternalEventBatcher,
): Record<string, unknown> {
  const astralStatus = astral.status();
  return {
    now: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    services: {
      onebot: {
        enabled: config.qq.enabled,
        ...onebot.status(),
      },
      telegram: telegram?.status() ?? { enabled: false, polling: false },
      astral: astralStatus,
      externalEvents: {
        enabled: config.externalEvents.enabled,
        path: config.externalEvents.path,
        schemaPath: `${config.externalEvents.path}/schema`,
        authRequired: Boolean(config.externalEvents.authToken),
        debounceMs: config.externalEvents.debounceMs,
        batcher: eventBatcher?.status() ?? null,
      },
    },
    routing: {
      threadId: astralStatus.threadId,
      configuredThreadId: astralStatus.configuredThreadId,
      threadIdSource: astralStatus.threadIdSource,
      autoThreadManaged: astralStatus.autoThreadManaged,
      rotateThreadOnStart: astralStatus.rotateThreadOnStart,
      qqBotUserId: config.qq.botUserId,
      allowedGroupIds: config.qq.allowedGroupIds,
      alwaysTriggerGroupIds: config.qq.alwaysTriggerGroupIds,
      allowedPrivateUserIds: config.qq.allowedPrivateUserIds,
      triggerKeywords: config.qq.triggerKeywords,
      recordUntriggered: config.qq.recordUntriggered,
      telegramEnabled: config.telegram.enabled,
      telegramBotUsername: config.telegram.botUsername,
      telegramAllowedChatIds: config.telegram.allowedChatIds,
      telegramAlwaysTriggerChatIds: config.telegram.alwaysTriggerChatIds,
      telegramTriggerKeywords: config.telegram.triggerKeywords,
      telegramRecordUntriggered: config.telegram.recordUntriggered,
    },
    logs: recentLogs(120),
  };
}

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Astral Bridge</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --sidebar: #10141a;
      --surface: #141920;
      --surface-2: #0f1318;
      --text: #e8edf2;
      --muted: #8f9baa;
      --line: #28313c;
      --line-soft: rgba(255, 255, 255, 0.055);
      --ok: #42d99b;
      --warn: #f2c94c;
      --bad: #ff7373;
      --accent: #82a7ff;
      --reasoning: #c39cff;
      --message: #73c8ff;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, summary { font: inherit; }
    header {
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: #0e1217;
    }
    h1 { margin: 0; font-size: 15px; font-weight: 680; }
    .header-status { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--muted); font-size: 12px; }
    .header-model { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .connection { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); }
    .dot.bad { background: var(--bad); }
    main {
      height: calc(100% - 52px);
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-width: 0;
    }
    aside {
      min-width: 0;
      overflow: auto;
      border-right: 1px solid var(--line);
      background: var(--sidebar);
    }
    .side-section { padding: 16px; border-bottom: 1px solid var(--line); }
    .section-title {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .status-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: baseline;
      padding: 4px 0;
    }
    .status-label { color: var(--muted); }
    .status-value { text-align: right; overflow-wrap: anywhere; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .queue-list { display: grid; gap: 7px; margin-top: 8px; }
    .queue-item { padding-left: 9px; border-left: 2px solid var(--warn); min-width: 0; }
    .queue-place { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .queue-text { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .workspace { min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
    .current-input {
      min-height: 94px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface-2);
    }
    .input-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 7px; }
    .input-place { font-weight: 650; }
    .input-sender { color: var(--accent); }
    .input-time { color: var(--muted); font-size: 12px; }
    .input-text { max-width: 1000px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .activity-shell { min-height: 0; display: grid; grid-template-rows: 46px minmax(0, 1fr); }
    .activity-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .activity-title { display: flex; align-items: baseline; gap: 8px; font-weight: 650; }
    .activity-count { color: var(--muted); font-size: 12px; font-weight: 500; }
    .segments { min-width: 0; display: flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--line); background: var(--surface-2); }
    .segments button {
      min-height: 28px;
      padding: 3px 9px;
      border: 0;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
    }
    .segments button.active { color: var(--text); background: #252c35; }
    .activity-scroll { min-height: 0; overflow: auto; background: var(--bg); }
    .empty { padding: 44px 18px; color: var(--muted); text-align: center; }
    .activity-item { border-bottom: 1px solid var(--line-soft); }
    .activity-item[open] { background: rgba(255, 255, 255, 0.018); }
    .activity-item summary {
      min-height: 43px;
      display: grid;
      grid-template-columns: 72px 12px minmax(130px, auto) minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 7px 18px;
      cursor: pointer;
      list-style: none;
    }
    .activity-item summary::-webkit-details-marker { display: none; }
    .activity-time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .activity-mark { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
    .category-reasoning .activity-mark { background: var(--reasoning); }
    .category-message .activity-mark { background: var(--message); }
    .status-running .activity-mark { box-shadow: 0 0 0 4px rgba(242, 201, 76, 0.12); background: var(--warn); }
    .status-failed .activity-mark { background: var(--bad); }
    .activity-name { font-weight: 620; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .activity-preview { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .activity-status { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .status-running .activity-status { color: var(--warn); }
    .status-failed .activity-status { color: var(--bad); }
    .activity-body { padding: 0 18px 14px 122px; }
    .block-label { margin: 9px 0 4px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .activity-body pre {
      margin: 0;
      max-width: 1100px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #dbe3eb;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .category-message .activity-body pre { font-family: inherit; font-size: 14px; }
    .category-reasoning .activity-body pre { color: #decdf7; font-family: inherit; font-size: 14px; }
    .debug summary { cursor: pointer; color: var(--muted); }
    .debug pre { margin: 10px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 900px) {
      body { overflow: auto; }
      header { position: sticky; top: 0; z-index: 2; }
      .header-status > :not(.connection):not(.header-model) { display: none; }
      main { height: auto; min-height: calc(100% - 52px); grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); overflow: visible; }
      .side-section { display: none; }
      .side-section:first-child, .side-section:nth-child(2), .side-section:nth-child(3) { display: block; }
      .workspace { overflow: visible; }
      .activity-scroll { overflow: visible; }
      .activity-toolbar { height: auto; min-height: 46px; display: grid; grid-template-columns: 100px minmax(0, 1fr); padding: 8px 12px; }
      .segments { width: 100%; overflow-x: auto; }
      .segments button { flex: 0 0 auto; }
      .activity-item summary { grid-template-columns: 58px 10px minmax(100px, auto) minmax(0, 1fr); padding: 7px 12px; }
      .activity-status { display: none; }
      .activity-body { padding: 0 12px 12px 90px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Astral Bridge</h1>
    <div class="header-status">
      <span id="streamConnection" class="connection"><span class="dot"></span><span>connecting</span></span>
      <span id="headerModel" class="header-model">model unknown</span>
      <span id="headerUptime">-</span>
      <span id="headerUpdated">-</span>
    </div>
  </header>
  <main>
    <aside>
      <section class="side-section">
        <h2 class="section-title">Services</h2>
        <div class="status-row"><span class="status-label">NapCat</span><span id="napcat" class="status-value">-</span></div>
        <div class="status-row"><span class="status-label">Telegram</span><span id="telegram" class="status-value">-</span></div>
        <div class="status-row"><span class="status-label">Astral</span><span id="astral" class="status-value">-</span></div>
      </section>
      <section class="side-section">
        <h2 class="section-title">Turn</h2>
        <div class="status-row"><span class="status-label">State</span><span id="turnState" class="status-value">idle</span></div>
        <div class="status-row"><span class="status-label">Elapsed</span><span id="turnElapsed" class="status-value">-</span></div>
        <div class="status-row"><span class="status-label">ID</span><span id="turnId" class="status-value mono">-</span></div>
        <div class="status-row"><span class="status-label">Context</span><span id="context" class="status-value">-</span></div>
        <div class="status-row"><span class="status-label">Cache hit</span><span id="cache" class="status-value">-</span></div>
        <div class="status-row"><span class="status-label">Compact</span><span id="compact" class="status-value">idle</span></div>
      </section>
      <section class="side-section">
        <h2 class="section-title">Inputs</h2>
        <div class="status-row"><span class="status-label">Active</span><span id="activeInputs" class="status-value">0</span></div>
        <div class="status-row"><span class="status-label">Waiting</span><span id="waitingInputs" class="status-value">0</span></div>
        <div id="queueList" class="queue-list"></div>
      </section>
      <section class="side-section">
        <details class="debug">
          <summary>Debug</summary>
          <div class="block-label">Routing</div>
          <pre id="routingDebug">-</pre>
          <div class="block-label">External events</div>
          <pre id="eventsDebug">-</pre>
          <div class="block-label">Bridge logs</div>
          <pre id="logsDebug">-</pre>
        </details>
      </section>
    </aside>
    <div class="workspace">
      <section id="currentInput" class="current-input">
        <h2 class="section-title">Current Input</h2>
        <div class="muted">Waiting for the next inbound event.</div>
      </section>
      <section class="activity-shell">
        <div class="activity-toolbar">
          <div class="activity-title">Live Activity <span id="activityCount" class="activity-count">0 / 500</span></div>
          <div id="filters" class="segments" aria-label="Activity filter">
            <button class="active" data-filter="all">All</button>
            <button data-filter="reasoning">Reasoning</button>
            <button data-filter="action">Actions</button>
            <button data-filter="message">Messages</button>
            <button data-filter="error">Errors</button>
          </div>
        </div>
        <div id="activityScroll" class="activity-scroll">
          <div id="activityEmpty" class="empty">Activity received after this page opens will appear here.</div>
          <div id="activityList"></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    const MAX_ACTIVITY = 500;
    const activities = [];
    const activityByKey = new Map();
    const inputs = new Map();
    const qs = (id) => document.getElementById(id);
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let currentFilter = 'all';
    let currentInput = null;
    let latestState = null;
    let activeTurnId = null;
    let turnStartedAt = null;
    let renderPending = false;
    let nextActivitySequence = 0;

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    }

    function formatTime(value) {
      const date = value ? new Date(value) : new Date();
      return Number.isNaN(date.getTime()) ? '' : clock.format(date);
    }

    function short(value, limit = 120) {
      const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
      return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
    }

    function pretty(value) {
      if (value === undefined || value === null || value === '') return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }

    function collectText(value) {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\\n');
      if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
      }
      return pretty(value);
    }

    function appendText(entry, field, delta) {
      if (typeof delta !== 'string' || !delta) return;
      entry[field] = String(entry[field] || '') + delta;
      entry.preview = short(entry.content || entry.summaryText || entry.rawText || entry.details);
      scheduleRender();
    }

    function kTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      const k = value / 1000;
      return (Math.abs(k) >= 100 ? k.toFixed(0) : k.toFixed(1)).replace(/\\.0$/, '') + 'k';
    }

    function duration(ms) {
      if (typeof ms !== 'number' || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      return minutes + 'm ' + seconds + 's';
    }

    function statusText(status) {
      if (status === 'running' || status === 'inProgress' || status === 'processing') return 'Running';
      if (status === 'failed' || status === 'declined') return 'Failed';
      if (status === 'queued') return 'Queued';
      if (status === 'interrupted') return 'Interrupted';
      return 'Done';
    }

    function normalizedStatus(status) {
      if (status === 'inProgress' || status === 'processing') return 'running';
      if (status === 'failed' || status === 'declined') return 'failed';
      if (status === 'queued') return 'queued';
      if (status === 'interrupted') return 'interrupted';
      return 'completed';
    }

    function upsertActivity(key, patch) {
      let entry = activityByKey.get(key);
      const eventTime = patch.emittedAt;
      if (!entry) {
        entry = {
          key,
          sequence: nextActivitySequence++,
          category: 'action',
          type: 'activity',
          status: 'completed',
          title: 'Activity',
          preview: '',
          content: '',
          details: '',
          emittedAt: new Date().toISOString(),
          startedAt: Date.now(),
          completedAt: null,
          expanded: false,
        };
        entry.lastEmittedAt = eventTime || entry.emittedAt;
        activities.push(entry);
        activityByKey.set(key, entry);
        Object.assign(entry, patch);
      } else {
        const update = { ...patch };
        delete update.emittedAt;
        Object.assign(entry, update);
        if (eventTime) entry.lastEmittedAt = eventTime;
      }
      while (activities.length > MAX_ACTIVITY) {
        const removed = activities.shift();
        if (removed) activityByKey.delete(removed.key);
      }
      scheduleRender();
      return entry;
    }

    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        renderActivity();
        renderInputs();
      });
    }

    function itemKey(params) {
      return 'item:' + String(params.turnId || activeTurnId || 'unknown') + ':' + String(params.itemId || (params.item && params.item.id) || 'unknown');
    }

    function describeItem(item) {
      const type = String(item.type || 'activity');
      const result = { type, title: type, category: 'action', content: '', details: '', preview: '' };
      if (type === 'reasoning') {
        result.title = 'Reasoning';
        result.category = 'reasoning';
        result.content = collectText(item.summary);
        result.details = collectText(item.content);
      } else if (type === 'agentMessage') {
        result.title = 'Assistant text · internal only';
        result.category = 'message';
        result.content = String(item.text || '');
      } else if (type === 'userMessage') {
        result.title = 'Input accepted';
        result.category = 'message';
        result.content = collectText(item.content);
      } else if (type === 'commandExecution') {
        const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || 'command');
        result.title = '$ ' + short(command, 100);
        result.content = command + (item.cwd ? '\\n\\ncwd: ' + item.cwd : '');
        result.details = String(item.aggregatedOutput || '');
      } else if (type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        result.title = changes.length ? 'Modify ' + changes.length + ' file' + (changes.length === 1 ? '' : 's') : 'File change';
        result.content = changes.map((change) => String(change.kind || 'change') + '  ' + String(change.path || '')).join('\\n');
        result.details = changes.map((change) => String(change.diff || '')).filter(Boolean).join('\\n\\n');
      } else if (type === 'mcpToolCall') {
        result.title = [item.server, item.tool].filter(Boolean).join(' / ') || 'MCP tool call';
        result.content = item.arguments === undefined ? '' : pretty(item.arguments);
        result.details = item.error ? 'Error\\n' + pretty(item.error) : pretty(item.result);
      } else if (type === 'dynamicToolCall') {
        result.title = String(item.tool || 'Dynamic tool call');
        result.content = pretty(item.arguments);
        result.details = pretty(item.contentItems || item.result || item.error);
      } else if (type === 'collabToolCall') {
        result.title = 'Sub-agent · ' + String(item.tool || 'collaboration');
        result.content = String(item.prompt || '');
        result.details = pretty({ receiverThreadId: item.receiverThreadId, newThreadId: item.newThreadId, agentStatus: item.agentStatus });
      } else if (type === 'webSearch') {
        result.title = 'Web search';
        result.content = String(item.query || '');
        result.details = pretty(item.action);
      } else if (type === 'imageView') {
        result.title = 'View image';
        result.content = String(item.path || '');
      } else if (type === 'contextCompaction' || type === 'compacted') {
        result.title = 'Context compact';
      } else if (type === 'plan') {
        result.title = 'Plan';
        result.content = String(item.text || '');
      } else {
        result.content = pretty(item);
      }
      result.preview = short(result.content || result.details || result.title);
      return result;
    }

    function applyItem(event, completed) {
      const params = event.params || {};
      const item = params.item || {};
      const description = describeItem(item);
      const patch = {
        ...description,
        status: completed ? normalizedStatus(item.status || 'completed') : normalizedStatus(item.status || 'running'),
        emittedAt: event.emittedAt,
        completedAt: completed ? Date.now() : null,
      };
      if (!completed) patch.startedAt = Number(params.startedAtMs) || Date.now();
      const entry = upsertActivity(itemKey(params), patch);
      if (description.type === 'reasoning') {
        if (description.content) entry.summaryText = description.content;
        if (description.details) entry.rawText = description.details;
        entry.expanded = !completed;
      }
      if (description.type === 'agentMessage') entry.expanded = !completed;
      if (completed && entry.startedAt) entry.durationMs = Date.now() - entry.startedAt;
    }

    function handleInputEvent(event) {
      const data = event.params || {};
      const id = String(data.id || 'input-' + Date.now());
      const phase = event.method.split('/').pop();
      const status = phase === 'queued' ? 'queued' : phase === 'processing' ? 'processing' : phase === 'failed' ? 'failed' : 'accepted';
      const input = { ...(inputs.get(id) || {}), ...data, id, status, updatedAt: event.emittedAt };
      inputs.set(id, input);
      currentInput = input;
      while (inputs.size > MAX_ACTIVITY) {
        const oldest = inputs.keys().next().value;
        if (oldest === undefined) break;
        inputs.delete(oldest);
      }
      const place = [data.platform, data.groupName || data.targetId, data.sourceType].filter(Boolean).join(' / ');
      upsertActivity('input:' + id, {
        category: phase === 'failed' ? 'error' : 'message',
        type: 'input',
        title: phase === 'queued' ? 'Input queued' : phase === 'processing' ? 'Processing input' : phase === 'failed' ? 'Input failed' : 'Input handed to Astral',
        status: phase === 'failed' ? 'failed' : phase === 'queued' ? 'queued' : phase === 'processing' ? 'running' : 'completed',
        content: [place, data.sender, data.text].filter(Boolean).join('\\n'),
        details: data.error ? String(data.error) : '',
        preview: short(data.text || place),
        emittedAt: event.emittedAt,
        completedAt: phase === 'submitted' || phase === 'failed' ? Date.now() : null,
      });
    }

    function handleDashboardEvent(event) {
      const method = String(event.method || '');
      const params = event.params || {};
      if (method === 'dashboard/connected') return;
      if (method.startsWith('bridge/input/')) {
        handleInputEvent(event);
        return;
      }
      if (method === 'turn/started') {
        const turn = params.turn || {};
        activeTurnId = String(turn.id || params.turnId || '');
        turnStartedAt = Date.now();
        upsertActivity('turn:' + activeTurnId, {
          category: 'action',
          type: 'turn',
          title: 'Turn started',
          status: 'running',
          preview: activeTurnId,
          content: activeTurnId,
          emittedAt: event.emittedAt,
          startedAt: turnStartedAt,
        });
        renderRuntime();
        return;
      }
      if (method === 'turn/completed') {
        const turn = params.turn || {};
        const turnId = String(turn.id || params.turnId || activeTurnId || 'unknown');
        const status = normalizedStatus(turn.status || (turn.error ? 'failed' : 'completed'));
        const entry = upsertActivity('turn:' + turnId, {
          title: status === 'failed' ? 'Turn failed' : status === 'interrupted' ? 'Turn interrupted' : 'Turn completed',
          category: status === 'failed' ? 'error' : 'action',
          status,
          details: pretty(turn.error),
          completedAt: Date.now(),
        });
        if (entry.startedAt) entry.durationMs = Date.now() - entry.startedAt;
        for (const input of inputs.values()) {
          if (input.status === 'accepted' || input.status === 'processing') input.status = 'completed';
        }
        activeTurnId = null;
        turnStartedAt = null;
        renderRuntime();
        return;
      }
      if (method === 'item/started') {
        applyItem(event, false);
        return;
      }
      if (method === 'item/completed') {
        applyItem(event, true);
        return;
      }
      if (method === 'item/agentMessage/delta') {
        const entry = upsertActivity(itemKey(params), { type: 'agentMessage', title: 'Assistant text · internal only', category: 'message', status: 'running', expanded: true, emittedAt: event.emittedAt });
        appendText(entry, 'content', params.delta);
        return;
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const entry = upsertActivity(itemKey(params), { type: 'reasoning', title: 'Reasoning', category: 'reasoning', status: 'running', expanded: true, emittedAt: event.emittedAt });
        appendText(entry, 'summaryText', params.delta);
        return;
      }
      if (method === 'item/reasoning/textDelta') {
        const entry = upsertActivity(itemKey(params), { type: 'reasoning', title: 'Reasoning', category: 'reasoning', status: 'running', expanded: true, emittedAt: event.emittedAt });
        appendText(entry, 'rawText', params.delta);
        return;
      }
      if (method === 'item/reasoning/summaryPartAdded') {
        const entry = upsertActivity(itemKey(params), { type: 'reasoning', title: 'Reasoning', category: 'reasoning', status: 'running', expanded: true, emittedAt: event.emittedAt });
        if (entry.summaryText) appendText(entry, 'summaryText', '\\n\\n');
        return;
      }
      if (method === 'item/commandExecution/outputDelta') {
        const entry = upsertActivity(itemKey(params), { type: 'commandExecution', category: 'action', status: 'running', emittedAt: event.emittedAt });
        appendText(entry, 'details', params.delta);
        return;
      }
      if (method === 'item/plan/delta') {
        const entry = upsertActivity(itemKey(params), { type: 'plan', title: 'Plan', category: 'action', status: 'running', emittedAt: event.emittedAt });
        appendText(entry, 'content', params.delta);
        return;
      }
      if (method === 'item/fileChange/patchUpdated') {
        const entry = upsertActivity(itemKey(params), { type: 'fileChange', title: 'File change', category: 'action', status: 'running', emittedAt: event.emittedAt });
        entry.details = pretty(params.patch || params.changes || params);
        entry.preview = short(entry.content || entry.details);
        scheduleRender();
        return;
      }
      if (method === 'turn/plan/updated') {
        upsertActivity('plan:' + String(params.turnId || activeTurnId || 'unknown'), {
          type: 'plan', title: 'Plan updated', category: 'action', status: 'completed', content: pretty(params.plan), details: String(params.explanation || ''), preview: short(params.explanation || pretty(params.plan)), emittedAt: event.emittedAt,
        });
        return;
      }
      if (method === 'turn/diff/updated') {
        upsertActivity('diff:' + String(params.turnId || activeTurnId || 'unknown'), {
          type: 'diff', title: 'Turn diff updated', category: 'action', status: 'completed', content: String(params.diff || ''), preview: short(params.diff || 'File changes updated'), emittedAt: event.emittedAt,
        });
        return;
      }
      if (method === 'thread/compacted') {
        upsertActivity('compact:' + String(params.turnId || Date.now()), {
          type: 'contextCompaction', title: 'Context compact completed', category: 'action', status: 'completed', content: pretty(params), preview: 'Conversation history compacted', emittedAt: event.emittedAt,
        });
        return;
      }
      if (method === 'model/rerouted') {
        upsertActivity('reroute:' + String(params.turnId || Date.now()), {
          type: 'model', title: 'Model rerouted', category: 'action', status: 'completed', content: pretty(params), preview: String(params.fromModel || '') + ' → ' + String(params.toModel || ''), emittedAt: event.emittedAt,
        });
        return;
      }
      if (method.startsWith('item/')) {
        const entry = upsertActivity(itemKey(params), {
          type: method, title: method, category: method.includes('failed') ? 'error' : 'action', status: method.includes('failed') ? 'failed' : 'completed', emittedAt: event.emittedAt,
        });
        entry.content = pretty(params);
        entry.preview = short(entry.content);
        scheduleRender();
      }
    }

    function renderEntryBody(entry) {
      const blocks = [];
      if (entry.type === 'reasoning') {
        if (entry.summaryText || entry.content) blocks.push(['Summary', entry.summaryText || entry.content]);
        if (entry.rawText || entry.details) blocks.push(['Reasoning', entry.rawText || entry.details]);
      } else {
        if (entry.content) blocks.push([entry.type === 'agentMessage' ? 'Text' : 'Input', entry.content]);
        if (entry.details) blocks.push([entry.status === 'failed' ? 'Error' : 'Output', entry.details]);
      }
      if (!blocks.length) return '';
      return '<div class="activity-body">' + blocks.map(([label, value]) => '<div class="block-label">' + esc(label) + '</div><pre>' + esc(value) + '</pre>').join('') + '</div>';
    }

    function renderActivity() {
      const scroller = qs('activityScroll');
      const shouldFollow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      const visible = activities.filter((entry) => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'error') return entry.status === 'failed' || entry.category === 'error';
        return entry.category === currentFilter;
      }).sort((left, right) => left.sequence - right.sequence);
      qs('activityEmpty').style.display = visible.length ? 'none' : 'block';
      qs('activityCount').textContent = activities.length + ' / ' + MAX_ACTIVITY;
      qs('activityList').innerHTML = visible.map((entry) => {
        const running = entry.status === 'running';
        const open = entry.expanded || (running && (entry.category === 'reasoning' || entry.type === 'agentMessage'));
        const elapsed = entry.durationMs ? duration(entry.durationMs) : running && entry.startedAt ? duration(Date.now() - entry.startedAt) : '';
        const preview = entry.preview || short(entry.content || entry.summaryText || entry.rawText || entry.details);
        return '<details class="activity-item category-' + esc(entry.category) + ' status-' + esc(entry.status) + '" data-key="' + esc(entry.key) + '"' + (open ? ' open' : '') + '>' +
          '<summary><span class="activity-time">' + esc(formatTime(entry.emittedAt)) + '</span><span class="activity-mark"></span><span class="activity-name">' + esc(entry.title) + '</span><span class="activity-preview">' + esc(preview) + '</span><span class="activity-status">' + esc(statusText(entry.status)) + (elapsed ? ' · ' + esc(elapsed) : '') + '</span></summary>' +
          renderEntryBody(entry) + '</details>';
      }).join('');
      if (shouldFollow) scroller.scrollTop = scroller.scrollHeight;
    }

    function renderInputs() {
      const values = Array.from(inputs.values());
      const waiting = values.filter((input) => input.status === 'queued');
      const active = values.filter((input) => input.status === 'processing' || input.status === 'accepted');
      qs('activeInputs').textContent = String(active.length);
      qs('waitingInputs').textContent = String(waiting.length);
      qs('queueList').innerHTML = waiting.slice(0, 5).map((input) => {
        const place = [input.platform, input.groupName || input.targetId].filter(Boolean).join(' / ');
        return '<div class="queue-item"><div class="queue-place">' + esc(place) + '</div><div class="queue-text">' + esc(short(input.text, 70)) + '</div></div>';
      }).join('');
      if (!currentInput) return;
      const place = [currentInput.platform, currentInput.groupName || currentInput.targetId, currentInput.sourceType].filter(Boolean).join(' / ');
      qs('currentInput').innerHTML = '<h2 class="section-title">Current Input</h2><div class="input-meta"><span class="input-place">' + esc(place) + '</span><span class="input-sender">' + esc(currentInput.sender || currentInput.userId || '') + '</span><span class="input-time">' + esc(formatTime(currentInput.occurredAt || currentInput.updatedAt)) + ' · ' + esc(currentInput.status) + '</span></div><div class="input-text">' + esc(currentInput.text || '[non-text input]') + '</div>';
    }

    function serviceState(enabled, connected) {
      if (!enabled) return '<span class="muted">disabled</span>';
      return connected ? '<span class="ok">connected</span>' : '<span class="bad">offline</span>';
    }

    function renderRuntime() {
      if (!latestState) return;
      const astralStatus = latestState.services.astral || {};
      const turnId = activeTurnId || astralStatus.activeTurnId || '';
      qs('napcat').innerHTML = serviceState(latestState.services.onebot.enabled, latestState.services.onebot.connected);
      qs('telegram').innerHTML = serviceState(latestState.services.telegram.enabled, latestState.services.telegram.polling);
      qs('astral').innerHTML = serviceState(true, astralStatus.connected);
      qs('turnState').innerHTML = turnId ? '<span class="warn">running</span>' : '<span class="muted">idle</span>';
      qs('turnId').textContent = turnId ? short(turnId, 16) : '-';
      qs('turnElapsed').textContent = turnId && turnStartedAt ? duration(Date.now() - turnStartedAt) : '-';
      const context = astralStatus.contextWindow;
      qs('context').textContent = context && typeof context.usedTokens === 'number' ? kTokens(context.usedTokens) + (typeof context.windowTokens === 'number' ? ' / ' + kTokens(context.windowTokens) : '') : 'unknown';
      const cache = astralStatus.cacheHitRate;
      qs('cache').textContent = cache && typeof cache.percent === 'number' ? cache.percent + '%' : 'unknown';
      const compact = astralStatus.compact;
      qs('compact').innerHTML = compact && compact.running ? '<span class="warn">running</span>' : '<span class="muted">idle</span>';
      const model = [astralStatus.modelProvider, astralStatus.model, astralStatus.reasoningEffort].filter(Boolean).join(' / ');
      qs('headerModel').textContent = model || 'model unknown';
      qs('headerUptime').textContent = Math.floor(latestState.uptimeSeconds / 60) + 'm uptime';
      qs('headerUpdated').textContent = formatTime(latestState.now);
    }

    function renderDebug() {
      if (!latestState) return;
      qs('routingDebug').textContent = pretty(latestState.routing);
      qs('eventsDebug').textContent = pretty(latestState.services.externalEvents);
      qs('logsDebug').textContent = (latestState.logs || []).map((entry) => '[' + entry.ts + '] ' + String(entry.level || '').toUpperCase() + ' ' + entry.message + (entry.meta === undefined ? '' : ' ' + pretty(entry.meta))).join('\\n');
    }

    async function loadState() {
      const response = await fetch('/api/dashboard/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('dashboard state HTTP ' + response.status);
      latestState = await response.json();
      if (!activeTurnId && latestState.services.astral.activeTurnId) activeTurnId = latestState.services.astral.activeTurnId;
      renderRuntime();
      renderDebug();
    }

    function setStreamState(state, label) {
      qs('streamConnection').innerHTML = '<span class="dot ' + esc(state) + '"></span><span>' + esc(label) + '</span>';
    }

    function connectActivityStream() {
      const source = new EventSource('/api/dashboard/events');
      source.onopen = () => setStreamState('ok', 'live');
      source.onmessage = (message) => {
        try { handleDashboardEvent(JSON.parse(message.data)); }
        catch (error) { setStreamState('bad', 'event error'); console.error(error); }
      };
      source.onerror = () => setStreamState('bad', 'reconnecting');
    }

    qs('filters').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      currentFilter = button.dataset.filter;
      for (const candidate of qs('filters').querySelectorAll('button')) candidate.classList.toggle('active', candidate === button);
      renderActivity();
    });

    qs('activityList').addEventListener('toggle', (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const entry = activityByKey.get(details.dataset.key);
      if (entry) entry.expanded = details.open;
    }, true);

    connectActivityStream();
    loadState().catch((error) => setStreamState('bad', String(error)));
    setInterval(() => loadState().catch((error) => setStreamState('bad', String(error))), 2000);
    setInterval(() => { renderRuntime(); if (activities.some((entry) => entry.status === 'running')) scheduleRender(); }, 1000);
  </script>
</body>
</html>`;
}
