import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, {
  DEFAULT_CONFIG,
  FLAG_NAMES,
  parseConfig,
} from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

test("uses conservative defaults", () => {
  assert.deepEqual(parseConfig({}), { ok: true, config: DEFAULT_CONFIG });
});

test("accepts every override", () => {
  assert.deepEqual(
    parseConfig({
      [FLAG_NAMES.minimumRunSeconds]: "2.5",
      [FLAG_NAMES.minimumAwaySeconds]: "0",
      [FLAG_NAMES.urgency]: "critical",
      [FLAG_NAMES.expirySeconds]: "1.25",
      [FLAG_NAMES.hidePrompt]: true,
    }),
    {
      ok: true,
      config: {
        minimumRunMs: 2500,
        minimumAwayMs: 0,
        urgency: "critical",
        expiryMs: 1250,
        showPrompt: false,
      },
    },
  );
});

for (const urgency of ["low", "normal", "critical"] as const) {
  test(`accepts ${urgency} urgency`, () => {
    const result = parseConfig({ [FLAG_NAMES.urgency]: urgency });
    assert.equal(result.ok && result.config.urgency, urgency);
  });
}

for (const [flag, value] of [
  [FLAG_NAMES.minimumRunSeconds, "-1"],
  [FLAG_NAMES.minimumAwaySeconds, "Infinity"],
  [FLAG_NAMES.expirySeconds, "1e308"],
  [FLAG_NAMES.expirySeconds, "NaN"],
  [FLAG_NAMES.minimumRunSeconds, ""],
  [FLAG_NAMES.minimumRunSeconds, true],
  [FLAG_NAMES.urgency, "urgent"],
] as const) {
  test(`rejects invalid ${flag} value ${JSON.stringify(value)}`, () => {
    const result = parseConfig({ [flag]: value });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, new RegExp(flag));
  });
}

test("registers prefixed flags with defaults and parses them on session start", async () => {
  const harness = createExtensionHarness({
    flags: {
      [FLAG_NAMES.minimumRunSeconds]: "0.5",
      [FLAG_NAMES.minimumAwaySeconds]: "0",
    },
  });

  heuristicNotify(harness.pi);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.deepEqual([...harness.flags], [
    [FLAG_NAMES.minimumRunSeconds, { description: "Minimum Pi run duration in seconds", type: "string", default: "10" }],
    [FLAG_NAMES.minimumAwaySeconds, { description: "Minimum continuously unfocused duration in seconds", type: "string", default: "5" }],
    [FLAG_NAMES.urgency, { description: "Notification urgency: low, normal, or critical", type: "string", default: "normal" }],
    [FLAG_NAMES.expirySeconds, { description: "Notification expiry time in seconds", type: "string", default: "10" }],
    [FLAG_NAMES.hidePrompt, { description: "Hide the last user prompt in notifications", type: "boolean", default: false }],
  ]);
  assert.deepEqual(harness.notifications, []);
});

test("reports invalid configuration and disables delivery", async () => {
  const harness = createExtensionHarness({
    flags: { [FLAG_NAMES.urgency]: "loud" },
  });

  heuristicNotify(harness.pi);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.deepEqual(harness.notifications, [
    {
      message: "pi-heuristic-notify disabled: --notify-urgency must be low, normal, or critical",
      type: "error",
    },
  ]);
});
