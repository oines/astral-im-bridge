import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardHtml } from "../src/dashboard.js";

test("dashboard serves a self-contained live activity monitor", () => {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "dashboard script should be present");
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /Live Activity/);
  assert.match(html, /new EventSource\('\/api\/dashboard\/events'\)/);
  assert.match(html, /const MAX_ACTIVITY = 500/);
  assert.doesNotMatch(html, /Recent Conversations|Recent Messages/);
});

test("dashboard keeps interleaved reasoning items in first-seen order", async () => {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  class FakeElement {
    innerHTML = "";
    textContent = "";
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    scrollHeight = 0;
    scrollTop = 0;
    clientHeight = 0;
    addEventListener(): void {}
    querySelectorAll(): unknown[] { return []; }
  }

  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    let value = elements.get(id);
    if (!value) {
      value = new FakeElement();
      elements.set(id, value);
    }
    return value;
  };
  const state = {
    now: "2026-08-07T00:00:00.000Z",
    uptimeSeconds: 1,
    services: {
      onebot: { enabled: true, connected: true },
      telegram: { enabled: true, polling: true },
      astral: { connected: true, activeTurnId: null, compact: { running: false } },
      externalEvents: {},
    },
    routing: {},
    logs: [],
  };
  const context = vm.createContext({
    console,
    document: { getElementById: (id: string) => element(id) },
    EventSource: class { onopen?: () => void; onmessage?: () => void; onerror?: () => void; },
    HTMLDetailsElement: class {},
    fetch: async () => ({ ok: true, json: async () => state }),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    setInterval: () => 1,
    Intl,
    Date,
    Map,
    JSON,
  });
  new vm.Script(script).runInContext(context);

  const emit = (method: string, params: Record<string, unknown>, emittedAt: string) => {
    (context.handleDashboardEvent as (event: unknown) => void)({ method, params, emittedAt });
  };
  emit("turn/started", { turn: { id: "turn-1" } }, "2026-08-07T00:00:01.000Z");
  emit("item/started", { turnId: "turn-1", item: { id: "reason-1", type: "reasoning" } }, "2026-08-07T00:00:02.000Z");
  emit("item/reasoning/textDelta", { turnId: "turn-1", itemId: "reason-1", delta: "first" }, "2026-08-07T00:00:03.000Z");
  emit("item/completed", { turnId: "turn-1", item: { id: "reason-1", type: "reasoning", content: ["first"] } }, "2026-08-07T00:00:04.000Z");
  emit("item/started", { turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", command: ["pwd"] } }, "2026-08-07T00:00:05.000Z");
  emit("item/completed", { turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", command: ["pwd"], aggregatedOutput: "/workspace" } }, "2026-08-07T00:00:06.000Z");
  emit("item/started", { turnId: "turn-1", item: { id: "reason-2", type: "reasoning" } }, "2026-08-07T00:00:07.000Z");
  emit("item/reasoning/textDelta", { turnId: "turn-1", itemId: "reason-2", delta: "second" }, "2026-08-07T00:00:08.000Z");
  emit("item/started", { turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: "done" } }, "2026-08-07T00:00:09.000Z");

  const timeline = new vm.Script(`activities
    .filter((entry) => ['reasoning', 'commandExecution', 'agentMessage'].includes(entry.type))
    .map((entry) => ({ key: entry.key, text: entry.rawText || entry.content, emittedAt: entry.emittedAt, lastEmittedAt: entry.lastEmittedAt }))`)
    .runInContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)), [
    { key: "item:turn-1:reason-1", text: "first", emittedAt: "2026-08-07T00:00:02.000Z", lastEmittedAt: "2026-08-07T00:00:04.000Z" },
    { key: "item:turn-1:tool-1", text: "pwd", emittedAt: "2026-08-07T00:00:05.000Z", lastEmittedAt: "2026-08-07T00:00:06.000Z" },
    { key: "item:turn-1:reason-2", text: "second", emittedAt: "2026-08-07T00:00:07.000Z", lastEmittedAt: "2026-08-07T00:00:08.000Z" },
    { key: "item:turn-1:message-1", text: "done", emittedAt: "2026-08-07T00:00:09.000Z", lastEmittedAt: "2026-08-07T00:00:09.000Z" },
  ]);
});
