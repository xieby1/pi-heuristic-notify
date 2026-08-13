import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import heuristicNotify, { FLAG_NAMES, type NotificationContent } from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const success: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

function diagnosticsScenario(options: {
  minimumRunSeconds?: string;
  minimumAwaySeconds?: string;
  env?: Record<string, string | undefined>;
  exec?: NonNullable<Parameters<typeof createExtensionHarness>[0]>["exec"];
} = {}) {
  const harness = createExtensionHarness({
    flags: {
      [FLAG_NAMES.minimumRunSeconds]: options.minimumRunSeconds ?? "10",
      [FLAG_NAMES.minimumAwaySeconds]: options.minimumAwaySeconds ?? "5",
    },
    ...(options.exec ? { exec: options.exec } : {}),
  });
  const sent: NotificationContent[] = [];
  let now = 0;
  let timer: { at: number; callback: () => void } | undefined;
  heuristicNotify(harness.pi, {
    now: () => now,
    env: options.env ?? {},
    platform: "linux",
    randomUUID: () => "diagnostic-id",
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
    focusIn() { harness.sendTerminalInput(FOCUS_IN); },
    focusOut() { harness.sendTerminalInput(FOCUS_OUT); },
    async start() {
      await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "diagnostic prompt" });
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
    async check(): Promise<string> {
      const before = harness.notifications.length;
      await harness.runCommand("notify-check");
      assert.equal(harness.notifications.length, before + 1);
      return harness.notifications.at(-1)!.message;
    },
    get timerAt() { return timer?.at; },
  };
}

async function startTui(s: ReturnType<typeof diagnosticsScenario>) {
  await s.harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "tui", hasUI: true },
  );
}

test("factory registers only required lifecycle handlers and diagnostic commands", () => {
  const harness = createExtensionHarness();
  heuristicNotify(harness.pi, { env: {}, writeTerminal: () => {}, notify: () => {} });

  assert.deepEqual([...harness.handlers].map(([event, handlers]) => [event, handlers.length]), [
    ["session_start", 1],
    ["before_agent_start", 1],
    ["agent_start", 1],
    ["agent_end", 1],
    ["agent_settled", 1],
    ["session_shutdown", 1],
  ]);
  assert.deepEqual([...harness.commands.keys()], ["notify-check", "notify-test"]);
  assert.equal(harness.commands.get("notify-check")?.description, "Show notification state and suppression reason");
  assert.equal(harness.commands.get("notify-test")?.description, "Send a test desktop notification");
});

test("notify-check reports config, focus, duration, pending state, backend, and unknown focus", async () => {
  const s = diagnosticsScenario({ env: { KITTY_WINDOW_ID: "42", TMUX_PANE: "%7" } });
  await startTui(s);

  assert.equal(await s.check(), [
    "Config: run >= 10s; away >= 5s; urgency normal; expiry 10s; prompt shown",
    "Focus: terminal events; unknown; away n/a",
    "Run: n/a",
    "Pending delivery: no",
    "Backend: Kitty + tmux pane %7",
    "Suppression: unknown focus",
  ].join("\n"));
});

test("notify-check reports each major eligibility gate", async () => {
  for (const gate of ["short run", "focused", "waiting for away threshold", "aborted", "eligible"] as const) {
    const minimumRunSeconds = gate === "short run" ? "10" : "0";
    const minimumAwaySeconds = gate === "waiting for away threshold" ? "5" : "0";
    const s = diagnosticsScenario({ minimumRunSeconds, minimumAwaySeconds });
    await startTui(s);
    s.focusOut();
    if (gate === "focused") s.focusIn();
    await s.start();
    s.setNow(gate === "short run" ? 9_999 : gate === "waiting for away threshold" ? 1_000 : 10_000);
    await s.end(gate === "aborted" ? "aborted" : "stop");
    await s.settle();

    const report = await s.check();
    assert.match(report, new RegExp(`Suppression: ${gate}$`), gate);
    assert.match(report, /Run: (9\.9s|1s|10s)/, gate);
    assert.equal(report.includes("Pending delivery: yes"), gate === "waiting for away threshold", gate);
    assert.equal(s.timerAt !== undefined, gate === "waiting for away threshold", gate);
    assert.equal(s.sent.length, gate === "eligible" ? 1 : 0, gate);
  }
});

test("session start resets diagnostic run state", async () => {
  const s = diagnosticsScenario({ minimumRunSeconds: "0", minimumAwaySeconds: "0" });
  await startTui(s);
  s.focusOut();
  await s.start();
  s.setNow(1_000);
  await s.end();
  await s.settle();
  assert.match(await s.check(), /Run: 1s[\s\S]*Suppression: eligible$/);

  await s.harness.emit(
    "session_start",
    { type: "session_start", reason: "switch" },
    { mode: "tui", hasUI: true },
  );
  assert.match(await s.check(), /Focus: terminal events; unknown; away n\/a[\s\S]*Run: n\/a[\s\S]*Suppression: unknown focus$/);
});

test("notify-test reports backend success and failure without throwing", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const s = diagnosticsScenario({
      env: { KITTY_WINDOW_ID: "42" },
      exec: ({ command }) => outcome === "success"
        ? success
        : { ...success, code: 1, stderr: `${command} failed` },
    });
    await startTui(s);

    await s.harness.runCommand("notify-test");

    const last = s.harness.notifications.at(-1)!;
    assert.equal(last.type, outcome === "success" ? "info" : "error");
    assert.match(
      last.message,
      outcome === "success"
        ? /Test notification sent/
        : /Test notification failed: kitten notify: kitten failed; notify-send: notify-send failed/,
    );
  }
});
