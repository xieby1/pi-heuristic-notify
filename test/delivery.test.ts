import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import heuristicNotify, {
  deliverNotification,
  FLAG_NAMES,
  type NotificationContent,
} from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const notification: NotificationContent = {
  title: "Pi run complete",
  body: "Prompt: inspect logs\nDuration: 12.5s",
  urgency: "critical",
  expiryMs: 2_500,
};
const success: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Kitty receives structured arguments and a unique session identifier", async () => {
  const harness = createExtensionHarness();

  assert.deepEqual(
    await deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42" },
      "pi-heuristic-notify-session-1",
      new AbortController().signal,
      "linux",
    ),
    { ok: true },
  );
  assert.deepEqual(harness.execCalls.map(({ command, args }) => ({ command, args })), [{
    command: "kitten",
    args: [
      "notify",
      "--app-name=Pi",
      "--icon=system-monitor",
      "--urgency=critical",
      "--expire-after=2.5s",
      "--identifier=pi-heuristic-notify-session-1",
      "--wait-for-completion",
      "Pi run complete",
      "Prompt: inspect logs\nDuration: 12.5s",
    ],
  }]);
  assert.ok(harness.execCalls[0]?.options?.signal);
});

test("Kitty failure falls back to notify-send without fallback after success", async () => {
  for (const kittyCode of [0, 1]) {
    const harness = createExtensionHarness({
      exec: ({ command }) => command === "kitten"
        ? { ...success, code: kittyCode, stderr: kittyCode ? "kitty failed" : "" }
        : success,
    });

    const result = await deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42" },
      "session-id",
      new AbortController().signal,
      "linux",
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      harness.execCalls.map(({ command }) => command),
      kittyCode === 0 ? ["kitten"] : ["kitten", "notify-send"],
    );
    if (kittyCode !== 0) {
      assert.deepEqual(harness.execCalls[1]?.args, [
        "--app-name=Pi",
        "--icon=system-monitor",
        "--urgency=critical",
        "--expire-time=2500",
        "Pi run complete",
        "Prompt: inspect logs\nDuration: 12.5s",
      ]);
    }
  }
});

test("tmux selects the captured pane only after Kitty activation", async () => {
  for (const activation of ["0\n", ""] as const) {
    const harness = createExtensionHarness({
      exec: ({ command }) => command === "kitten" ? { ...success, stdout: activation } : success,
    });

    const result = await deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42", tmuxPane: "%7" },
      "session-id",
      new AbortController().signal,
      "linux",
    );

    assert.deepEqual(
      harness.execCalls.map(({ command, args }) => ({ command, args })),
      activation
        ? [
            { command: "kitten", args: harness.execCalls[0]!.args },
            { command: "tmux", args: ["select-pane", "-t", "%7"] },
          ]
        : [{ command: "kitten", args: harness.execCalls[0]!.args }],
    );
    assert.deepEqual(result, { ok: true });
  }
});

test("tmux selection failure after activation does not send a duplicate fallback", async () => {
  const harness = createExtensionHarness({
    exec: ({ command }) => {
      if (command === "kitten") return { ...success, stdout: "0\n" };
      if (command === "tmux") throw new Error("tmux unavailable");
      return success;
    },
  });

  const result = await deliverNotification(
    harness.pi,
    notification,
    { kittyWindowId: "42", tmuxPane: "%7" },
    "session-id",
    new AbortController().signal,
    "linux",
  );

  assert.deepEqual(result, { ok: false, error: "tmux: tmux unavailable" });
  assert.deepEqual(harness.execCalls.map(({ command }) => command), ["kitten", "tmux"]);
});

test("notification close or expiry, command failure, and abort do not select a tmux pane or reject", async () => {
  for (const outcome of ["close", "expiry", "failure", "abort"] as const) {
    const controller = new AbortController();
    const harness = createExtensionHarness({
      exec: ({ command, options }) => {
        if (command !== "kitten") return { ...success, code: 1, stderr: "fallback failed" };
        if (outcome === "close" || outcome === "expiry") return success;
        if (outcome === "failure") return { ...success, code: 1, stderr: "kitty failed" };
        return new Promise((resolve) => options?.signal?.addEventListener("abort", () => {
          resolve({ ...success, code: 1, killed: true });
        }, { once: true }));
      },
    });

    const pending = deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42", tmuxPane: "%7" },
      "session-id",
      controller.signal,
      "linux",
    );
    if (outcome === "abort") controller.abort();
    const result = await pending;

    assert.equal(harness.execCalls.some(({ command }) => command === "tmux"), false);
    assert.equal(result.ok, outcome === "close" || outcome === "expiry");
    if (outcome === "abort") assert.deepEqual(result, { ok: false, aborted: true });
  }
});

test("factory captures origin, generates IDs per session, reports failure, and aborts on shutdown", async () => {
  const controllers: AbortSignal[] = [];
  let resolveKitten: ((result: ExecResult) => void) | undefined;
  const harness = createExtensionHarness({
    flags: {
      [FLAG_NAMES.minimumRunSeconds]: "0",
      [FLAG_NAMES.minimumAwaySeconds]: "0",
    },
    exec: ({ command, options }) => {
      if (command === "kitten") {
        controllers.push(options!.signal!);
        return new Promise((resolve) => { resolveKitten = resolve; });
      }
      return { ...success, code: 1, stderr: "notify-send failed" };
    },
  });
  const ids = ["first", "second"];
  heuristicNotify(harness.pi, {
    env: { KITTY_WINDOW_ID: "42", TMUX_PANE: "%7" },
    platform: "linux",
    randomUUID: () => ids.shift()!,
    writeTerminal: () => {},
  });

  for (const reason of ["startup", "switch"] as const) {
    await harness.emit(
      "session_start",
      { type: "session_start", reason },
      { mode: "tui", hasUI: true },
    );
    harness.sendTerminalInput("\x1b[O");
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: reason });
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.match(harness.execCalls.at(-1)!.args.join(" "), new RegExp(`session-${reason === "startup" ? "first" : "second"}`));
    resolveKitten!({ ...success, code: 1, stderr: "kitty failed" });
    await flush();
  }

  assert.equal(harness.notifications.at(-1)?.type, "error");
  assert.match(harness.notifications.at(-1)?.message ?? "", /kitty failed.*notify-send failed/);

  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "shutdown" });
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await harness.emit("agent_settled", { type: "agent_settled" });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(controllers.at(-1)?.aborted, true);
});
