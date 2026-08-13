import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, { DEFAULT_CONFIG, type EligibleRun } from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

function scenario(minimumRunSeconds = 10, minimumAwaySeconds = 5) {
  const harness = createExtensionHarness();
  const eligible: EligibleRun[] = [];
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
    onEligible: (run) => { eligible.push(run); },
    schedule: (delayMs, callback) => {
      timer = { at: now + delayMs, callback };
      return () => { timer = undefined; };
    },
  });

  return {
    harness,
    eligible,
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
    assert.equal(s.eligible.length > 0, expected, `run=${runMs} away=${awayMs}`);
  }
});

test("emits only after agent_settled and keeps the first start and latest prompt", async () => {
  const s = scenario();
  await startTui(s);
  s.harness.sendTerminalInput(FOCUS_OUT);
  await s.start("first prompt");
  s.setNow(4_000);
  await s.start("queued follow-up");
  s.setNow(10_000);
  await s.end("error");
  assert.deepEqual(s.eligible, []);
  await s.end("stop");
  await s.settle();
  assert.deepEqual(s.eligible, [{ prompt: "queued follow-up", runDurationMs: 10_000 }]);
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

  assert.deepEqual(s.eligible, []);
  assert.equal(s.timerAt, 13_000);
  s.setNow(12_999);
  s.runTimer();
  assert.deepEqual(s.eligible, []);
  s.setNow(13_000);
  s.runTimer();
  assert.deepEqual(s.eligible, [{ prompt: "latest prompt", runDurationMs: 10_000 }]);
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
    assert.deepEqual(s.eligible, [], mode);
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
    assert.deepEqual(s.eligible, []);
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
  assert.deepEqual(s.eligible, [{ prompt: "one", runDurationMs: 10_000 }]);
});
