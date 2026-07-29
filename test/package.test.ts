import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const piPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

test("package Node floor matches the tested Pi packages", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(root.engines?.node, ">=22.19.0");
  for (const name of piPackages) {
    const manifest = JSON.parse(
      await readFile(join("node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(manifest.engines?.node, ">=22.19.0");
  }
});
