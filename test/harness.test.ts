import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness } from "./harness.ts";

test("captures and drives the Pi APIs used by extensions", async () => {
  const harness = createExtensionHarness();
  let eventSeen = "";

  const extension = (pi: ExtensionAPI) => {
    pi.on("agent_start", async (event, ctx) => {
      eventSeen = `${event.type}:${ctx.cwd}`;
      ctx.ui.onTerminalInput((data) => ({ data: data.toUpperCase() }));
      await pi.exec("notify-send", ["Pi", "done"]);
    });
    pi.registerCommand("check", {
      handler: async (_args, ctx) => ctx.ui.notify("checked", "info"),
    });
  };

  extension(harness.pi);
  await harness.emit("agent_start", { type: "agent_start" });

  assert.equal(eventSeen, `agent_start:${process.cwd()}`);
  assert.deepEqual(harness.sendTerminalInput("focus"), [{ data: "FOCUS" }]);
  assert.deepEqual(harness.execCalls, [
    { command: "notify-send", args: ["Pi", "done"], options: undefined },
  ]);
  assert.equal(harness.commands.has("check"), true);

  await harness.runCommand("check");
  assert.deepEqual(harness.notifications, [{ message: "checked", type: "info" }]);
});
