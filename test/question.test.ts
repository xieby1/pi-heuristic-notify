import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, { DEFAULT_CONFIG, type NotificationContent } from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

function scenario(options: { minimumAwayMs?: number; notifyOnQuestion?: boolean; showPrompt?: boolean } = {}) {
  const harness = createExtensionHarness();
  const sent: NotificationContent[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 0;
  let now = 0;
  heuristicNotify(harness.pi, {
    now: () => now,
    writeTerminal: () => {},
    notify: (notification) => { sent.push(notification); },
    loadConfig: () => ({ ok: true, config: {
      ...DEFAULT_CONFIG,
      minimumAwayMs: options.minimumAwayMs ?? 5_000,
      notifyOnQuestion: options.notifyOnQuestion ?? true,
      showPrompt: options.showPrompt ?? true,
    } }),
    schedule: (delayMs, callback) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delayMs, callback });
      return () => { timers.delete(id); };
    },
  });
  return {
    harness, sent,
    get timerTimes() { return [...timers.values()].map(({ at }) => at).sort((a, b) => a - b); },
    advanceTo(time: number) {
      while ([...timers.values()].some(({ at }) => at <= time)) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]!;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = time;
    },
    async start(focus = true) {
      await harness.emit("session_start", { type: "session_start", reason: "startup" },
        { mode: "tui", hasUI: true });
      if (focus) harness.sendTerminalInput("\x1b[O");
      await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "original prompt" });
      await harness.emit("agent_start", { type: "agent_start" });
    },
    open(id = "ask-1", question = "Which option?") {
      harness.emitEvent("rpiv:ask-user:prompt", { toolCallId: id, questions: [{ question }] });
      harness.emitEvent("rpiv:ask-user:blocked", { toolCallId: id, active: true });
    },
    close(id = "ask-1") {
      harness.emitEvent("rpiv:ask-user:blocked", { toolCallId: id, active: false });
    },
  };
}

test("notifies while blocked at the away threshold even when the run is short", async () => {
  const s = scenario();
  await s.start();
  s.advanceTo(1_000);
  s.open("ask-1", "Which option?\nPlease choose.");
  assert.deepEqual(s.timerTimes, [5_000]);
  s.advanceTo(4_999);
  assert.deepEqual(s.sent, []);
  s.advanceTo(5_000);
  assert.deepEqual(s.sent, [{
    title: "Pi needs your input",
    body: "Question: Which option? Please choose.\nPrompt: original prompt\nDuration: 5s",
    urgency: "normal",
    expiryMs: 10_000,
  }]);
  s.harness.emitEvent("rpiv:ask-user:blocked", { toolCallId: "ask-1", active: true });
  s.advanceTo(20_000);
  assert.equal(s.sent.length, 1);
});

test("notifies on blocked without requiring a ready event", async () => {
  const s = scenario({ minimumAwayMs: 0 });
  await s.start();
  s.open();
  s.advanceTo(0);
  assert.equal(s.sent[0]?.title, "Pi needs your input");
});

test("cancels an away-threshold timer on answer, focus, or shutdown", async () => {
  for (const cancel of ["answer", "focus", "shutdown"] as const) {
    const s = scenario();
    await s.start();
    s.advanceTo(1_000);
    s.open();
    assert.deepEqual(s.timerTimes, [5_000]);
    s.advanceTo(2_000);
    if (cancel === "answer") s.close();
    if (cancel === "focus") s.harness.sendTerminalInput("\x1b[I");
    if (cancel === "shutdown") await s.harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.deepEqual(s.timerTimes, [], cancel);
    s.advanceTo(5_000);
    assert.deepEqual(s.sent, [], cancel);
    if (cancel === "focus") {
      s.harness.sendTerminalInput("\x1b[O");
      s.advanceTo(20_000);
      assert.deepEqual(s.sent, [], "refocusing suppresses this questionnaire permanently");
    }
  }
});

test("unknown or focused terminal stays silent for a visible question", async () => {
  const s = scenario();
  await s.start(false);
  s.open();
  s.advanceTo(10_000);
  assert.deepEqual(s.sent, []);
  s.harness.sendTerminalInput("\x1b[O");
  s.advanceTo(15_000);
  assert.deepEqual(s.sent, [], "a later FocusOut cannot revive an initially unknown question");

  const watched = scenario();
  await watched.start();
  watched.harness.sendTerminalInput("\x1b[I");
  watched.open();
  watched.harness.sendTerminalInput("\x1b[O");
  watched.advanceTo(15_000);
  assert.deepEqual(watched.sent, [], "question seen while focused is not revived later");
});

test("pairs overlapping questionnaires by toolCallId", async () => {
  const s = scenario({ minimumAwayMs: 0 });
  await s.start();
  s.advanceTo(1_000);
  s.open("ask-1", "First?");
  s.open("ask-2", "Second?");
  s.close("ask-1");
  s.advanceTo(1_000);
  assert.deepEqual(s.sent.map(({ body }) => body), ["Question: Second?\nPrompt: original prompt\nDuration: 1s"]);
});

test("question alerts use the existing Kitty origin delivery", async () => {
  const harness = createExtensionHarness();
  let now = 0;
  let fire: (() => void) | undefined;
  heuristicNotify(harness.pi, {
    now: () => now,
    writeTerminal: () => {},
    env: { KITTY_WINDOW_ID: "42" },
    platform: "linux",
    randomUUID: () => "question-id",
    loadConfig: () => ({ ok: true, config: { ...DEFAULT_CONFIG, minimumAwayMs: 0 } }),
    schedule: (_delayMs, callback) => { fire = callback; return () => { fire = undefined; }; },
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui", hasUI: true });
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "original prompt" });
  await harness.emit("agent_start", { type: "agent_start" });
  now = 1_000;
  harness.emitEvent("rpiv:ask-user:prompt", { toolCallId: "ask-1", questions: [{ question: "Which option?" }] });
  harness.emitEvent("rpiv:ask-user:blocked", { toolCallId: "ask-1", active: true });
  fire?.();
  assert.deepEqual(harness.execCalls[0]?.args, [
    "notify", "--app-name=Pi", "--icon=system-monitor", "--urgency=normal",
    "--expire-after=10s", "--identifier=pi-heuristic-notify-session-question-id",
    "--wait-for-completion", "Pi needs your input",
    "Question: Which option?\nPrompt: original prompt\nDuration: 1s",
  ]);
});

test("session shutdown removes question listeners before reload", async () => {
  const s = scenario();
  await s.start();
  for (const channel of ["rpiv:ask-user:prompt", "rpiv:ask-user:blocked"]) {
    assert.equal(s.harness.eventListenerCount(channel), 1, channel);
  }
  assert.equal(s.harness.eventListenerCount("rpiv:ask-user:ready"), 0);
  await s.harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
  for (const channel of ["rpiv:ask-user:prompt", "rpiv:ask-user:blocked"]) {
    assert.equal(s.harness.eventListenerCount(channel), 0, channel);
  }
  await s.start();
  assert.equal(s.harness.eventListenerCount("rpiv:ask-user:blocked"), 1);
});

test("question notifications can be disabled and respect prompt privacy", async () => {
  const disabled = scenario({ minimumAwayMs: 0, notifyOnQuestion: false });
  await disabled.start();
  disabled.open();
  disabled.advanceTo(1_000);
  assert.deepEqual(disabled.sent, []);

  const privateQuestion = scenario({ minimumAwayMs: 0, showPrompt: false });
  await privateQuestion.start();
  privateQuestion.advanceTo(1_000);
  privateQuestion.open();
  privateQuestion.advanceTo(1_000);
  assert.equal(privateQuestion.sent[0]?.body, "Duration: 1s");
});
