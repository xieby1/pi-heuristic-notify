import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import heuristicNotify, { DEFAULT_CONFIG, deliverNotification, type NotificationContent } from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const notification: NotificationContent = {
  title: "Pi run complete",
  body: "Prompt: inspect logs\nDuration: 12.5s",
  urgency: "critical",
  expiryMs: 2_500,
};
const success: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
const osc = "\x1b]777;notify;Pi run complete;Prompt: inspect logs | Duration: 12.5s\x07";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Ghostty notifies the originating surface without running an external command", async () => {
  const harness = createExtensionHarness();
  const written: string[] = [];
  assert.deepEqual(
    await deliverNotification(harness.pi, notification, { ghostty: true }, new AbortController().signal, "linux", (data) => written.push(data)),
    { ok: true },
  );
  assert.deepEqual(written, [osc]);
  assert.deepEqual(harness.execCalls, []);
});

test("OSC fields cannot inject another terminal command", async () => {
  const harness = createExtensionHarness();
  const written: string[] = [];
  const hostile = { ...notification, title: "Hi;\x07\x1b]9;bad", body: "Prompt; hi\x07\x1b]9;bad\nDuration: 1s" };
  await deliverNotification(harness.pi, hostile, { ghostty: true }, new AbortController().signal, "linux", (data) => written.push(data));
  assert.deepEqual(written, ["\x1b]777;notify;Hi   ]9 bad;Prompt; hi  ]9;bad | Duration: 1s\x07"]);
});

test("aborted deliveries never write to the terminal", async () => {
  const harness = createExtensionHarness();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await deliverNotification(harness.pi, notification, { ghostty: true }, controller.signal, "linux", () => assert.fail("must not write")),
    { ok: false, aborted: true },
  );
});

test("failed Ghostty delivery falls back to notify-send and reports failures", async () => {
  for (const code of [0, 1]) {
    const harness = createExtensionHarness({ exec: () => ({ ...success, code, stderr: code ? "daemon failed" : "" }) });
    const result = await deliverNotification(
      harness.pi, notification, { ghostty: true }, new AbortController().signal, "linux", () => { throw new Error("tty unavailable"); },
    );
    assert.deepEqual(result, code ? { ok: false, error: "Ghostty: tty unavailable; notify-send: daemon failed" } : { ok: true });
    assert.deepEqual(harness.execCalls.map(({ command }) => command), ["notify-send"]);
  }
});

test("no controlling TTY falls back to notify-send without leaking OSC to stdout", async () => {
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const script = `
    import { deliverNotification } from ${JSON.stringify(moduleUrl)};
    const calls = [];
    const pi = { exec: async (command) => { calls.push(command); return { code: 0, stdout: "", stderr: "" }; } };
    const result = await deliverNotification(pi,
      { title: "test", body: "body", urgency: "normal", expiryMs: 1000 },
      { ghostty: true }, new AbortController().signal, "linux");
    process.stdout.write(JSON.stringify({ result, calls }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { result: { ok: true }, calls: ["notify-send"] });
});

test("outside Ghostty, Linux uses notify-send", async () => {
  const harness = createExtensionHarness();
  assert.deepEqual(
    await deliverNotification(harness.pi, notification, { ghostty: false }, new AbortController().signal, "linux"),
    { ok: true },
  );
  assert.deepEqual(harness.execCalls[0]?.args, [
    "--app-name=Pi", "--icon=system-monitor", "--urgency=critical", "--expire-time=2500",
    "Pi run complete", "Prompt: inspect logs\nDuration: 12.5s",
  ]);
});

test("outside Ghostty and Linux, there is no supported backend", async () => {
  const harness = createExtensionHarness();
  assert.deepEqual(
    await deliverNotification(harness.pi, notification, { ghostty: false }, new AbortController().signal, "darwin"),
    { ok: false, error: "no supported notification backend" },
  );
  assert.deepEqual(harness.execCalls, []);
});

test("factory sends a settled run through Ghostty and stops reporting focus on shutdown", async () => {
  const harness = createExtensionHarness();
  const writes: string[] = [];
  heuristicNotify(harness.pi, {
    loadConfig: () => ({ ok: true, config: { ...DEFAULT_CONFIG, minimumRunMs: 0, minimumAwayMs: 0 } }),
    env: { TERM_PROGRAM: "ghostty" },
    writeTerminal: (data) => { writes.push(data); },
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui", hasUI: true });
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "ship this" });
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  await harness.emit("agent_settled", { type: "agent_settled" });
  await flush();
  assert.match(writes.at(-1) ?? "", /^\x1b]777;notify;Pi run complete;Prompt: ship this \| Duration: /);
  assert.deepEqual(harness.execCalls, []);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(writes.at(-1), "\x1b[?1004l");
});

test("pending notify-send delivery is aborted on shutdown", async () => {
  const harness = createExtensionHarness({ exec: () => new Promise(() => {}) });
  heuristicNotify(harness.pi, {
    loadConfig: () => ({ ok: true, config: { ...DEFAULT_CONFIG, minimumRunMs: 0, minimumAwayMs: 0 } }),
    env: {}, platform: "linux", writeTerminal: () => {},
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui", hasUI: true });
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.execCalls[0]?.options?.signal?.aborted, false);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(harness.execCalls[0]?.options?.signal?.aborted, true);
});
