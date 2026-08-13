import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeDependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

test("the deployed package declares no npm runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  for (const field of runtimeDependencyFields) {
    assert.equal(field in manifest, false, `package.json must not declare ${field}`);
  }
});
