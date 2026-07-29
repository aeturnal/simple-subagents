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

test("package exposes public release metadata and license", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const license = await readFile("LICENSE", "utf8");

  assert.deepEqual(root.repository, {
    type: "git",
    url: "git+https://github.com/aeturnal/simple-subagents.git",
  });
  assert.equal(root.homepage, "https://github.com/aeturnal/simple-subagents#readme");
  assert.deepEqual(root.bugs, { url: "https://github.com/aeturnal/simple-subagents/issues" });
  assert.deepEqual(root.publishConfig, { access: "public" });
  assert.equal(root.license, "MIT");
  assert.match(license, /Copyright \(c\) 2026 AETURNAL, LLC/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});
