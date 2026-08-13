import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

test("loads the TypeScript extension entrypoint", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-heuristic-notify-"));
  const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    additionalExtensionPaths: [entrypoint],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  try {
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0]?.path, entrypoint);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
