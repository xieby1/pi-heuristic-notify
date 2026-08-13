import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, {
  buildNotification,
  DEFAULT_CONFIG,
  FLAG_NAMES,
  formatDuration,
  sanitizePrompt,
  type NotificationContent,
} from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

test("normalizes whitespace and removes terminal and control characters", () => {
  assert.equal(
    sanitizePrompt("  hello\n\t\x1b[31mworld\x1b[0m\x07  "),
    "hello world",
  );
});

test("truncates prompts to 160 Unicode code points without splitting characters", () => {
  const prompt = sanitizePrompt("😀".repeat(161));
  assert.equal(Array.from(prompt).length, 160);
  assert.equal(prompt, `${"😀".repeat(157)}...`);
});

test("formats durations at millisecond, second, and minute boundaries", () => {
  for (const [durationMs, expected] of [
    [0, "0ms"],
    [999, "999ms"],
    [1_000, "1s"],
    [1_500, "1.5s"],
    [59_999, "59.9s"],
    [60_000, "1m"],
    [61_000, "1m 1s"],
    [120_000, "2m"],
  ] as const) {
    assert.equal(formatDuration(durationMs), expected, `${durationMs}ms`);
  }
});

test("builds notification content with prompt, duration, urgency, and expiry", () => {
  assert.deepEqual(
    buildNotification({ prompt: "  ship\nthis  ", runDurationMs: 12_500 }, DEFAULT_CONFIG),
    {
      title: "Pi run complete",
      body: "Prompt: ship this\nDuration: 12.5s",
      urgency: "normal",
      expiryMs: 10_000,
    },
  );
});

test("uses a neutral empty-prompt fallback", () => {
  assert.equal(
    buildNotification({ prompt: "\n\x1b[31m\x1b[0m", runDurationMs: 10_000 }, DEFAULT_CONFIG).body,
    "Prompt: No prompt\nDuration: 10s",
  );
});

test("hides the prompt while retaining duration", () => {
  assert.equal(
    buildNotification(
      { prompt: "secret", runDurationMs: 10_000 },
      { ...DEFAULT_CONFIG, showPrompt: false },
    ).body,
    "Duration: 10s",
  );
});

test("automatic eligibility emits structured notification content without shell execution", async () => {
  const harness = createExtensionHarness({
    flags: {
      [FLAG_NAMES.minimumRunSeconds]: "0",
      [FLAG_NAMES.minimumAwaySeconds]: "0",
      [FLAG_NAMES.urgency]: "critical",
      [FLAG_NAMES.expirySeconds]: "2.5",
    },
  });
  const notifications: NotificationContent[] = [];
  let now = 0;
  heuristicNotify(harness.pi, {
    env: {},
    now: () => now,
    writeTerminal: () => {},
    notify: (notification) => { notifications.push(notification); },
  });

  await harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "tui", hasUI: true },
  );
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "  inspect\n\x1b[31mlogs\x1b[0m  ",
  });
  await harness.emit("agent_start", { type: "agent_start" });
  now = 1_500;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await harness.emit("agent_settled", { type: "agent_settled" });

  assert.deepEqual(notifications, [{
    title: "Pi run complete",
    body: "Prompt: inspect logs\nDuration: 1.5s",
    urgency: "critical",
    expiryMs: 2_500,
  }]);
  assert.deepEqual(harness.execCalls, []);
});
