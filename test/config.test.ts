import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import heuristicNotify, {
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  type NotificationContent,
} from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

test("uses conservative defaults", () => {
  assert.deepEqual(parseConfig({}), { ok: true, config: DEFAULT_CONFIG });
});

test("merges partial JSON configuration over defaults", () => {
  assert.deepEqual(parseConfig({ minimumRunSeconds: 2.5 }), {
    ok: true,
    config: { ...DEFAULT_CONFIG, minimumRunMs: 2_500 },
  });
});

test("accepts every JSON configuration property", () => {
  assert.deepEqual(
    parseConfig({
      minimumRunSeconds: 2.5,
      minimumAwaySeconds: 0,
      urgency: "critical",
      expirySeconds: 1.25,
      showPrompt: false,
    }),
    {
      ok: true,
      config: {
        minimumRunMs: 2_500,
        minimumAwayMs: 0,
        urgency: "critical",
        expiryMs: 1_250,
        showPrompt: false,
      },
    },
  );
});

for (const urgency of ["low", "normal", "critical"] as const) {
  test(`accepts ${urgency} urgency`, () => {
    const result = parseConfig({ urgency });
    assert.equal(result.ok && result.config.urgency, urgency);
  });
}

for (const [property, value] of [
  ["minimumRunSeconds", -1],
  ["minimumAwaySeconds", Infinity],
  ["expirySeconds", Number.MAX_VALUE],
  ["expirySeconds", NaN],
  ["minimumRunSeconds", "1"],
  ["minimumAwaySeconds", true],
  ["expirySeconds", null],
  ["urgency", "urgent"],
  ["showPrompt", "false"],
] as const) {
  test(`rejects invalid ${property} value ${JSON.stringify(value)}`, () => {
    const result = parseConfig({ [property]: value });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, new RegExp(property));
  });
}

for (const property of ["minimumRunSeconds", "minimumAwaySeconds", "expirySeconds"] as const) {
  test(`accepts zero and fractional ${property}`, () => {
    for (const value of [0, 0.5]) assert.equal(parseConfig({ [property]: value }).ok, true);
  });
}

for (const showPrompt of [true, false]) {
  test(`accepts showPrompt ${showPrompt}`, () => {
    const result = parseConfig({ showPrompt });
    assert.equal(result.ok && result.config.showPrompt, showPrompt);
  });
}

test("resolves configuration under Pi's agent directory", () => {
  assert.equal(configPath(), join(getAgentDir(), "pi-heuristic-notify.json"));
  assert.equal(
    configPath("/custom/pi-agent"),
    join("/custom/pi-agent", "pi-heuristic-notify.json"),
  );
});

test("missing configuration uses defaults", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-heuristic-notify-config-"));
  try {
    assert.deepEqual(loadConfig(agentDir), { ok: true, config: DEFAULT_CONFIG });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("loads partial configuration from JSON", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-heuristic-notify-config-"));
  try {
    await writeFile(configPath(agentDir), JSON.stringify({ minimumAwaySeconds: 2.5, showPrompt: false }));
    assert.deepEqual(loadConfig(agentDir), {
      ok: true,
      config: { ...DEFAULT_CONFIG, minimumAwayMs: 2_500, showPrompt: false },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

for (const [name, contents] of [
  ["malformed JSON", "{"],
  ["non-object root", "[]"],
  ["invalid property", JSON.stringify({ urgency: "urgent" })],
] as const) {
  test(`reports the path for ${name}`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-heuristic-notify-config-"));
    const path = configPath(agentDir);
    try {
      await writeFile(path, contents);
      const result = loadConfig(agentDir);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.startsWith(`${path}:`), true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
}

test("session start loads configuration once and applies it", async () => {
  const harness = createExtensionHarness();
  const sent: NotificationContent[] = [];
  let reads = 0;
  let now = 0;
  heuristicNotify(harness.pi, {
    now: () => now,
    writeTerminal: () => {},
    notify: (notification) => { sent.push(notification); },
    loadConfig: () => {
      reads++;
      return {
        ok: true,
        config: {
          ...DEFAULT_CONFIG,
          minimumRunMs: 0,
          minimumAwayMs: 0,
          urgency: "critical",
          expiryMs: 2_500,
          showPrompt: false,
        },
      };
    },
  });

  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui" });
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "secret" });
  await harness.emit("agent_start", { type: "agent_start" });
  now = 1_000;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await harness.emit("agent_settled", { type: "agent_settled" });
  await harness.runCommand("notify-check");

  assert.equal(reads, 1);
  assert.match(harness.notifications.at(-1)!.message, /Config: run >= 0ms; away >= 0ms; urgency critical; expiry 2\.5s; prompt hidden/);
  assert.deepEqual(sent, [{
    body: "Duration: 1s",
    urgency: "critical",
    expiryMs: 2_500,
    title: "Pi run complete",
  }]);
});

test("registers no CLI flags", () => {
  const harness = createExtensionHarness();
  heuristicNotify(harness.pi);
});

test("invalid configuration disables automatic and test delivery", async () => {
  const harness = createExtensionHarness();
  const sent: unknown[] = [];
  let now = 0;
  heuristicNotify(harness.pi, {
    now: () => now,
    writeTerminal: () => {},
    notify: (notification) => { sent.push(notification); },
    loadConfig: () => ({ ok: false, error: "/agent/pi-heuristic-notify.json: urgency must be low, normal, or critical" }),
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui" });
  harness.sendTerminalInput("\x1b[O");
  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "ignored" });
  await harness.emit("agent_start", { type: "agent_start" });
  now = 10_000;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await harness.emit("agent_settled", { type: "agent_settled" });
  await harness.runCommand("notify-test");

  assert.deepEqual(sent, []);
  assert.deepEqual(harness.notifications, [
    {
      message: "pi-heuristic-notify disabled: /agent/pi-heuristic-notify.json: urgency must be low, normal, or critical",
      type: "error",
    },
    { message: "Test notification failed: invalid configuration", type: "error" },
  ]);
});

test("new session reads changed configuration", async () => {
  const harness = createExtensionHarness();
  let minimumRunMs = 1_000;
  heuristicNotify(harness.pi, {
    loadConfig: () => ({ ok: true, config: { ...DEFAULT_CONFIG, minimumRunMs } }),
  });

  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.runCommand("notify-check");
  assert.match(harness.notifications.at(-1)!.message, /Config: run >= 1s/);

  minimumRunMs = 2_000;
  await harness.emit("session_start", { type: "session_start", reason: "switch" });
  await harness.runCommand("notify-check");
  assert.match(harness.notifications.at(-1)!.message, /Config: run >= 2s/);
});
