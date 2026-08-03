import assert from "node:assert/strict";
import test from "node:test";
import { isThinkingLevel, modelThinkingSuffix } from "../src/thinking.ts";
import { THINKING_LEVELS } from "../src/types.ts";

test("accepts exactly Pi thinking levels", () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const value of [undefined, null, 1, "", " medium ", "MEDIUM", "ultra", "none"])
    assert.equal(isThinkingLevel(value), false, String(value));
});

test("detects only reserved final model suffixes", () => {
  for (const level of THINKING_LEVELS)
    assert.equal(modelThinkingSuffix(`provider/model:${level}`), level);
  for (const model of [
    "provider/model",
    "ollama/llama3.1:8b",
    "vendor/model:preview",
    "vendor/model:real:tag",
  ]) assert.equal(modelThinkingSuffix(model), undefined, model);
});
