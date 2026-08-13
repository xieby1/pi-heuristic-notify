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
      message: "pi-heuristic-notify disabled: urgency must be low, normal, or critical",
      type: "error",
    },
  ]);
});
