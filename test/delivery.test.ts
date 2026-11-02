import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import heuristicNotify, {
  captureNiriWindowId,
  DEFAULT_CONFIG,
  deliverNotification,
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

test("niri capture accepts only the originating Kitty process", async () => {
  for (const [focusedWindow, expected] of [
    [{ id: 162, app_id: "kitty", pid: 493_513 }, 162],
    [{ id: 162, app_id: "firefox", pid: 493_513 }, undefined],
    [{ id: 162, app_id: "kitty", pid: 1 }, undefined],
    [{ id: "162", app_id: "kitty", pid: 493_513 }, undefined],
  ] as const) {
    const harness = createExtensionHarness({
      exec: () => ({ ...success, stdout: JSON.stringify(focusedWindow) }),
    });

    assert.equal(
      await captureNiriWindowId(harness.pi, "493513", new AbortController().signal),
      expected,
    );
    assert.deepEqual(harness.execCalls[0]?.args, ["msg", "--json", "focused-window"]);
  }
});

test("niri capture ignores unavailable IPC, malformed output, and failed identity checks", async () => {
  for (const exec of [
    () => { throw new Error("niri unavailable"); },
    () => ({ ...success, stdout: "not json" }),
    () => ({ ...success, code: 1, stderr: "IPC failed" }),
  ]) {
    const harness = createExtensionHarness({ exec });
    assert.equal(
      await captureNiriWindowId(harness.pi, "493513", new AbortController().signal),
      undefined,
    );
  }
});

test("niri delivery observes the DMS action and restores window, Kitty tab, then tmux pane", async () => {
  const harness = createExtensionHarness({
    exec: ({ command, args }) => command === "notify-send"
      ? { ...success, stdout: "default\n" }
      : command === "niri" && args.includes("focused-window")
        ? { ...success, stdout: JSON.stringify({ id: 162 }) }
        : success,
  });

  assert.deepEqual(
    await deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42", niriWindowId: 162, tmuxPane: "%7" },
      "session-id",
      new AbortController().signal,
      "linux",
    ),
    { ok: true },
  );
  assert.deepEqual(harness.execCalls.map(({ command, args }) => ({ command, args })), [
    { command: "notify-send", args: [
      "--app-name=Pi",
      "--icon=system-monitor",
      "--urgency=critical",
      "--expire-time=2500",
      "--action=default=Open",
      "Pi run complete",
      "Prompt: inspect logs\nDuration: 12.5s",
    ] },
    { command: "niri", args: ["msg", "action", "focus-window", "--id", "162"] },
    { command: "kitten", args: ["@", "focus-window", "--match", "id:42"] },
    { command: "tmux", args: ["select-pane", "-t", "%7"] },
    { command: "niri", args: ["msg", "--json", "focused-window"] },
  ]);
});

test("niri retries when focus command succeeds but the originating workspace stays inactive", async () => {
  let attempts = 0;
  const harness = createExtensionHarness({
    exec: ({ command, args }) => {
      if (command === "notify-send") return { ...success, stdout: "default\n" };
      if (command === "niri" && args.includes("focus-window")) attempts++;
      if (command === "niri" && args.includes("focused-window")) {
        return { ...success, stdout: JSON.stringify({ id: attempts < 2 ? 60 : 162 }) };
      }
      return success;
    },
  });

  assert.deepEqual(
    await deliverNotification(
      harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
      "session-id", new AbortController().signal, "linux", async () => {},
    ),
    { ok: true },
  );
  assert.equal(attempts, 2);
  assert.equal(harness.execCalls.at(-1)?.args.includes("focused-window"), true);
});

test("niri does not retry after focus changes during the wait", async () => {
  for (const [afterWait, expected] of [
    [162, { ok: true }],
    [90, { ok: false, error: "niri: focus changed before retry" }],
  ] as const) {
    let focusedId = 60;
    let attempts = 0;
    const harness = createExtensionHarness({
      exec: ({ command, args }) => {
        if (command === "notify-send") return { ...success, stdout: "default\n" };
        if (command === "niri" && args.includes("focus-window")) {
          attempts++;
          if (attempts > 1) focusedId = 162;
        }
        if (command === "niri" && args.includes("focused-window")) {
          return { ...success, stdout: JSON.stringify({ id: focusedId }) };
        }
        return success;
      },
    });
    assert.deepEqual(
      await deliverNotification(
        harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
        "session-id", new AbortController().signal, "linux", async () => { focusedId = afterWait; },
      ),
      expected,
    );
    assert.equal(attempts, 1);
  }
});

test("niri still restores the OS window when Kitty focus fails", async () => {
  let focusAttempts = 0;
  const harness = createExtensionHarness({
    exec: ({ command, args }) => {
      if (command === "notify-send") return { ...success, stdout: "default\n" };
      if (command === "kitten") return { ...success, code: 1, stderr: "remote unavailable" };
      if (command === "niri" && args.includes("focus-window")) focusAttempts++;
      if (command === "niri" && args.includes("focused-window")) {
        return { ...success, stdout: JSON.stringify({ id: focusAttempts < 2 ? 60 : 162 }) };
      }
      return success;
    },
  });
  assert.deepEqual(
    await deliverNotification(
      harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
      "session-id", new AbortController().signal, "linux", async () => {},
    ),
    { ok: false, error: "kitten: remote unavailable" },
  );
  assert.equal(focusAttempts, 2);
});

test("niri reports a successful focus command that never reaches the originating window", async () => {
  const harness = createExtensionHarness({
    exec: ({ command, args }) => command === "notify-send"
      ? { ...success, stdout: "default\n" }
      : command === "niri" && args.includes("focused-window")
        ? { ...success, stdout: JSON.stringify({ id: 60 }) }
        : success,
  });
  assert.deepEqual(
    await deliverNotification(
      harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
      "session-id", new AbortController().signal, "linux", async () => {},
    ),
    { ok: false, error: "niri: focus-window did not focus window 162" },
  );
  assert.equal(harness.execCalls.filter(({ args }) => args.includes("focus-window") && args[0] === "msg").length, 2);
});

test("aborting a pending niri retry does not focus a window", async () => {
  const controller = new AbortController();
  const harness = createExtensionHarness({
    exec: ({ command, args }) => command === "notify-send"
      ? { ...success, stdout: "default\n" }
      : command === "niri" && args.includes("focused-window")
        ? { ...success, stdout: JSON.stringify({ id: 60 }) }
        : success,
  });
  const result = await deliverNotification(
    harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
    "session-id", controller.signal, "linux", async () => { controller.abort(); },
  );
  assert.deepEqual(result, { ok: false, aborted: true });
  assert.equal(harness.execCalls.filter(({ command, args }) => command === "niri" && args.includes("focus-window")).length, 1);
});

test("niri verification errors identify the failing command", async () => {
  const harness = createExtensionHarness({
    exec: ({ command, args }) => command === "notify-send"
      ? { ...success, stdout: "default\n" }
      : command === "niri" && args.includes("focused-window")
        ? { ...success, code: 1, stderr: "IPC failed" }
        : success,
  });
  const result = await deliverNotification(
    harness.pi, notification, { kittyWindowId: "42", niriWindowId: 162 },
    "session-id", new AbortController().signal, "linux", async () => {},
  );
  assert.deepEqual(result, { ok: false, error: "niri focused-window: IPC failed" });
});

test("niri delivery failures remain non-fatal and never focus another window", async () => {
  for (const failure of ["notify-send", "niri", "kitten"] as const) {
    const harness = createExtensionHarness({
      exec: ({ command, args }) => {
        if (command === "notify-send") {
          return failure === command
            ? { ...success, code: 1, stderr: "notification failed" }
            : { ...success, stdout: "default\n" };
        }
        if (command === "niri" && args.includes("focused-window")) {
          return { ...success, stdout: JSON.stringify({ id: 162 }) };
        }
        return command === failure
          ? { ...success, code: 1, stderr: `${command} failed` }
          : success;
      },
    });

    const result = await deliverNotification(
      harness.pi,
      notification,
      { kittyWindowId: "42", niriWindowId: 162, tmuxPane: "%7" },
      "session-id",
      new AbortController().signal,
      "linux",
    );

    assert.equal(result.ok, false);
    assert.equal(
      harness.execCalls.some(({ command }) => command === "tmux"),
      failure !== "notify-send",
    );
    assert.equal(
      harness.execCalls.filter(({ command }) => command === "niri").length,
      failure === "notify-send" ? 0 : 2,
    );
  }
});

test("factory resolves the niri origin at session start without polling", async () => {
  const harness = createExtensionHarness({
    exec: ({ command }) => command === "niri"
      ? { ...success, stdout: JSON.stringify({ id: 162, app_id: "kitty", pid: 493_513 }) }
      : success,
  });
  heuristicNotify(harness.pi, {
    env: {
      KITTY_PID: "493513",
      KITTY_WINDOW_ID: "42",
      NIRI_SOCKET: "/run/user/1000/niri.sock",
    },
    writeTerminal: () => {},
  });

  assert.equal(harness.execCalls.length, 0);
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui" });
  await flush();
  assert.deepEqual(harness.execCalls.map(({ command, args }) => ({ command, args })), [
    { command: "niri", args: ["msg", "--json", "focused-window"] },
  ]);
});

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
    loadConfig: () => ({
      ok: true,
      config: { ...DEFAULT_CONFIG, minimumRunMs: 0, minimumAwayMs: 0 },
    }),
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
