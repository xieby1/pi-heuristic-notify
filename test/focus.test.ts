import assert from "node:assert/strict";
import test from "node:test";
import heuristicNotify, {
  continuousAwayMs,
  createFocusState,
  scanFocusInput,
} from "../src/index.ts";
import { createExtensionHarness } from "./harness.ts";

const ESC = "\x1b";
const FOCUS_IN = `${ESC}[I`;
const FOCUS_OUT = `${ESC}[O`;

test("passes input without focus sequences through unchanged", () => {
  const state = createFocusState();
  assert.equal(scanFocusInput("hello", state, 100), undefined);
  assert.deepEqual(state, { focused: true, observed: false, unfocusedSince: undefined });
});

test("consumes standalone focus sequences and tracks transitions", () => {
  const state = createFocusState();

  assert.equal(scanFocusInput(FOCUS_OUT, state, 100), null);
  assert.deepEqual(state, { focused: false, observed: true, unfocusedSince: 100 });
  assert.equal(continuousAwayMs(state, 140), 40);

  assert.equal(scanFocusInput(FOCUS_IN, state, 150), null);
  assert.deepEqual(state, { focused: true, observed: true, unfocusedSince: undefined });
  assert.equal(continuousAwayMs(state, 160), undefined);
});

test("repeated FocusOut does not reset continuous-away time", () => {
  const state = createFocusState();
  scanFocusInput(FOCUS_OUT, state, 100);
  scanFocusInput(FOCUS_OUT, state, 200);
  assert.equal(state.unfocusedSince, 100);
  assert.equal(continuousAwayMs(state, 250), 150);
});

test("strips mixed and interleaved focus sequences while preserving input", () => {
  const state = createFocusState();
  assert.equal(scanFocusInput(`a${FOCUS_OUT}b${FOCUS_IN}c`, state, 100), "abc");
  assert.deepEqual(state, { focused: true, observed: true, unfocusedSince: undefined });
  assert.equal(scanFocusInput(`${FOCUS_IN}${FOCUS_OUT}`, state, 200), null);
  assert.deepEqual(state, { focused: false, observed: true, unfocusedSince: 200 });
});

test("unknown focus never yields a continuous-away duration", () => {
  const state = createFocusState();
  state.focused = false;
  state.unfocusedSince = 0;
  assert.equal(continuousAwayMs(state, 10_000), undefined);
});

test("fresh focus states do not share observations", () => {
  const first = createFocusState();
  const second = createFocusState();
  scanFocusInput(FOCUS_OUT, first, 100);
  assert.deepEqual(second, { focused: true, observed: false, unfocusedSince: undefined });
});

test("enables focus reporting in TUI mode and preserves unrelated input", async () => {
  const harness = createExtensionHarness();
  const writes: string[] = [];
  let now = 100;
  heuristicNotify(harness.pi, { now: () => now, writeTerminal: (data) => writes.push(data) });

  await harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "tui", hasUI: true },
  );
  assert.deepEqual(writes, [`${ESC}[?1004h`]);
  assert.deepEqual(harness.sendTerminalInput(`a${FOCUS_OUT}b`), [{ data: "ab" }]);

  now = 200;
  assert.deepEqual(harness.sendTerminalInput(FOCUS_OUT), [{ consume: true }]);
});

test("does not enable focus reporting outside TUI mode", async () => {
  const harness = createExtensionHarness();
  const writes: string[] = [];
  heuristicNotify(harness.pi, { writeTerminal: (data) => writes.push(data) });

  await harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "print", hasUI: false },
  );

  assert.deepEqual(writes, []);
  assert.deepEqual(harness.sendTerminalInput(FOCUS_OUT), []);
});

test("shutdown removes the listener and disables focus reporting once", async () => {
  const harness = createExtensionHarness();
  const writes: string[] = [];
  heuristicNotify(harness.pi, { writeTerminal: (data) => writes.push(data) });

  await harness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { mode: "tui", hasUI: true },
  );
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

  assert.deepEqual(harness.sendTerminalInput(FOCUS_OUT), []);
  assert.deepEqual(writes, [`${ESC}[?1004h`, `${ESC}[?1004l`]);
});
