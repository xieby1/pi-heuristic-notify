import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, { DEFAULT_CONFIG, type NotificationContent } from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

function scenario(minimumRunSeconds = 10, minimumAwaySeconds = 5) {
  const harness = createExtensionHarness();
  const sent: NotificationContent[] = [];
  let now = 0;
  let timer: { at: number; callback: () => void } | undefined;
  heuristicNotify(harness.pi, {
    loadConfig: () => ({
      ok: true,
      config: {
        ...DEFAULT_CONFIG,
        minimumRunMs: minimumRunSeconds * 1_000,
        minimumAwayMs: minimumAwaySeconds * 1_000,
      },
    }),
    now: () => now,
    writeTerminal: () => {},
    notify: (notification) => { sent.push(notification); },
    schedule: (delayMs, callback) => {
      timer = { at: now + delayMs, callback };
      return () => { timer = undefined; };
    },
  });

  return {
    harness,
    sent,
    setNow(value: number) { now = value; },
    get timerAt() { return timer?.at; },
    runTimer() {
      if (timer && timer.at <= now) {
        const callback = timer.callback;
        timer = undefined;
        callback();
      }
    },
    async start(prompt = "latest prompt") {
      await harness.emit("before_agent_start", {
        type: "before_agent_start",
        prompt,
      });
      await harness.emit("agent_start", { type: "agent_start" });
    },
    async retry() {
      await harness.emit("before_agent_start", {
        type: "before_agent_start",
        messageType: "custom",
        message: { role: "custom", content: "Retry the previous request." },
      });
      await harness.emit("agent_start", { type: "agent_start" });
    },
    async end(stopReason = "stop") {
      await harness.emit("agent_end", {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason }],
      });
    },
    async settle() {
      await harness.emit("agent_settled", { type: "agent_settled" });
    },
  };
}

async function startTui(s: ReturnType<typeof scenario>) {
  await s.harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "tui", hasUI: true },
  );
}

test("requires both thresholds at their exact boundaries", async () => {
  for (const [runMs, awayMs, expected] of [
    [9_999, 5_000, false],
    [10_000, 4_999, false],
    [10_000, 5_000, true],
    [10_001, 5_001, true],
  ] as const) {
    const s = scenario();
    await startTui(s);
    await s.start();
    s.setNow(runMs - awayMs);
    s.harness.sendTerminalInput(FOCUS_OUT);
    s.setNow(runMs);
    await s.end();
    await s.settle();
    assert.equal(s.sent.length > 0, expected, `run=${runMs} away=${awayMs}`);
  }
});

test("a final error becomes eligible only after agent_settled", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("failing prompt");
  s.setNow(10_000);
  await s.end("error");
  assert.equal(s.sent.length, 0);

  await s.settle();

  assert.equal(s.sent[0]?.title, "Pi run failed");
  assert.equal(s.sent[0]?.body, "Prompt: failing prompt\nDuration: 10s");
});

test("the final agent end determines the settled outcome", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("first prompt");
  s.setNow(4_000);
  await s.end("error");
  assert.equal(s.sent.length, 0);

  await s.start("queued follow-up");
  s.setNow(10_000);
  await s.end("stop");
  assert.equal(s.sent.length, 0);
  await s.settle();

  assert.equal(s.sent[0]?.title, "Pi run complete");
  assert.equal(s.sent[0]?.body, "Prompt: queued follow-up\nDuration: 10s");
});

test("custom-triggered runs keep the last user prompt", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("human prompt");
  s.setNow(10_000);
  await s.end();
  await s.settle();

  await s.harness.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "custom",
    message: { role: "custom", content: "automatic follow-up" },
  });
  await s.harness.emit("agent_start", { type: "agent_start" });
  s.setNow(20_000);
  await s.end();
  await s.settle();

  assert.equal(s.sent[1]?.body, "Prompt: human prompt\nDuration: 10s");
});

test("custom runs after a session switch do not reveal the previous prompt", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("private session A");
  s.setNow(10_000);
  await s.end();
  await s.settle();

  await s.harness.emit("session_start", { type: "session_start", reason: "switch" }, { mode: "tui", hasUI: true });
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.harness.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "custom",
    message: { role: "custom", content: "background work" },
  });
  await s.harness.emit("agent_start", { type: "agent_start" });
  s.setNow(20_000);
  await s.end();
  await s.settle();

  assert.equal(s.sent[1]?.body, "Prompt: No prompt\nDuration: 10s");
});

test("delays until the remaining continuous-away threshold", async () => {
  const s = scenario(10, 5);
  await startTui(s);
  await s.start();
  s.setNow(8_000);
  s.harness.sendTerminalInput(FOCUS_OUT);
  s.setNow(10_000);
  await s.end();
  await s.settle();

  assert.equal(s.sent.length, 0);
  assert.equal(s.timerAt, 13_000);
  s.setNow(12_999);
  s.runTimer();
  assert.equal(s.sent.length, 0);
  s.setNow(13_000);
  s.runTimer();
  assert.equal(s.sent[0]?.body, "Prompt: latest prompt\nDuration: 10s");
});

test("focused, unknown, short, aborted, and interrupted completions stay silent", async () => {
  for (const mode of ["focused", "unknown", "short", "aborted", "interrupted"] as const) {
    const s = scenario();
    await startTui(s);
    if (mode !== "unknown") s.harness.sendTerminalInput(FOCUS_OUT);
    if (mode === "focused") s.harness.sendTerminalInput(FOCUS_IN);
    await s.start();
    s.setNow(mode === "short" ? 9_999 : 10_000);
    if (mode !== "interrupted") await s.end(mode === "aborted" ? "aborted" : "stop");
    await s.settle();
    assert.equal(s.sent.length, 0, mode);
    assert.equal(s.timerAt, undefined, mode);
  }
});

test("refocus cancels delayed eligibility and a later FocusOut does not revive it", async () => {
  for (const refocus of [FOCUS_IN, `${FOCUS_IN}${FOCUS_OUT}`]) {
    const s = scenario();
    await startTui(s);
    await s.start();
    s.setNow(8_000);
    s.harness.sendTerminalInput(FOCUS_OUT);
    s.setNow(10_000);
    await s.end();
    await s.settle();
    assert.equal(s.timerAt, 13_000);

    s.setNow(11_000);
    s.harness.sendTerminalInput(refocus);
    s.setNow(12_000);
    s.harness.sendTerminalInput(FOCUS_OUT);
    s.setNow(20_000);
    s.runTimer();
    assert.equal(s.sent.length, 0);
  }
});

test("a new run or session shutdown cancels delayed eligibility", async () => {
  for (const cancel of ["new-run", "shutdown"] as const) {
    const s = scenario();
    await startTui(s);
    await s.start();
    s.setNow(8_000);
    s.harness.sendTerminalInput(FOCUS_OUT);
    s.setNow(10_000);
    await s.end();
    await s.settle();
    assert.equal(s.timerAt, 13_000);

    if (cancel === "new-run") await s.start("next run");
    else await s.harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.equal(s.timerAt, undefined);
  }
});

test("each settled run emits at most once and resets state", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("one");
  s.setNow(10_000);
  await s.end();
  await s.settle();
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]?.body, "Prompt: one\nDuration: 10s");
});

test("pi-retry hides failed attempts and notifies once after recovery", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("original prompt");
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  assert.equal(s.sent.length, 0);
  assert.equal(s.timerAt, undefined);

  await s.retry();
  s.setNow(20_000);
  await s.end("error");
  await s.settle();
  assert.equal(s.sent.length, 0);

  await s.retry();
  s.setNow(30_000);
  await s.end();
  await s.settle();
  assert.equal(s.sent.length, 0);
  s.harness.emitEvent("pi-retry:completed", { retryId: 2 });
  assert.equal(s.sent.length, 0);
  s.harness.emitEvent("pi-retry:completed", { retryId: 1 });
  assert.deepEqual(s.sent, [{
    title: "Pi run complete",
    body: "Prompt: original prompt\nDuration: 30s",
    urgency: "normal",
    expiryMs: 10_000,
  }]);
});

test("pi-retry gives up after retries and notifies only the terminal error", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("original prompt");
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  assert.equal(s.sent.length, 0);

  await s.retry();
  s.setNow(20_000);
  await s.end("error");
  await s.settle();
  assert.equal(s.sent.length, 0);
  s.harness.emitEvent("pi-retry:cancelled", { retryId: 1 });
  assert.equal(s.sent[0]?.title, "Pi run failed");
  assert.equal(s.sent[0]?.body, "Prompt: original prompt\nDuration: 20s");
});

test("retry completion before final retry starts waits for settlement", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start();
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  s.harness.emitEvent("pi-retry:completed", { retryId: 1 });
  assert.equal(s.sent.length, 0);
  await s.retry();
  s.setNow(20_000);
  await s.end();
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]?.body, "Prompt: latest prompt\nDuration: 20s");
});

test("retry outcome uses final settlement time, not later lifecycle timing", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start();
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  await s.retry();
  s.setNow(20_000);
  await s.end();
  await s.settle();
  s.setNow(25_000);
  s.harness.emitEvent("pi-retry:completed", { retryId: 1 });
  assert.equal(s.sent[0]?.body, "Prompt: latest prompt\nDuration: 20s");
});

test("retry recovery watched at settlement stays silent if unfocused later", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start();
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  await s.retry();
  s.harness.sendTerminalInput(FOCUS_IN);
  s.setNow(20_000);
  await s.end();
  await s.settle();
  s.harness.sendTerminalInput(FOCUS_OUT);
  s.setNow(30_000);
  s.harness.emitEvent("pi-retry:completed", { retryId: 1 });
  assert.equal(s.sent.length, 0);
  assert.equal(s.timerAt, undefined);
});

test("new user input cancels an old retry without suppressing the next run", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("old prompt");
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();

  s.setNow(12_000);
  await s.harness.emit("input", { type: "input" });
  s.harness.emitEvent("pi-retry:cancelled", { retryId: 1 });
  assert.equal(s.sent.length, 0);
  await s.start("new prompt");
  s.setNow(22_000);
  await s.end();
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]?.body, "Prompt: new prompt\nDuration: 10s");
});

test("an aborted retry with an error-shaped response stays silent", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start();
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  await s.retry();
  const abort = new AbortController();
  abort.abort();
  s.setNow(20_000);
  await s.harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error" }],
  }, { signal: abort.signal });
  s.harness.emitEvent("pi-retry:cancelled", { retryId: 1 });
  await s.settle();
  assert.equal(s.sent.length, 0);
});

test("retry listeners are removed on shutdown and restored on session start", async () => {
  const s = scenario();
  await startTui(s);
  assert.equal(s.harness.eventListenerCount("pi-retry:started"), 1);
  await s.harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
  assert.equal(s.harness.eventListenerCount("pi-retry:started"), 0);
  assert.equal(s.harness.eventListenerCount("pi-retry:completed"), 0);
  await startTui(s);
  assert.equal(s.harness.eventListenerCount("pi-retry:started"), 1);
});

test("cancelling pi-retry with Escape does not notify the earlier error", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start();
  s.setNow(10_000);
  await s.end("error");
  s.harness.emitEvent("pi-retry:started", { retryId: 1 });
  await s.settle();
  s.harness.sendTerminalInput("\x1b");
  s.harness.emitEvent("pi-retry:cancelled", { retryId: 1 });
  assert.equal(s.sent.length, 0);
});
