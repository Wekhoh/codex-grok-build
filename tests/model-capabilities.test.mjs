import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelCapabilityCatalog,
  chooseModel,
  chooseReasoningEffort,
  parseBridgeReasoningEfforts,
  parseModels,
  patchBridgeReasoningEfforts,
  unionReasoningEfforts
} from "../plugins/grok-build/scripts/lib/model-capabilities.mjs";

const MODEL_OUTPUT = `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

const MODEL_CACHE = {
  fetched_at: "2026-08-30T18:46:43Z",
  grok_version: "1.0.13",
  models: {
    "grok-4.6": {
      info: {
        reasoning_effort: "high",
        context_window: 500000,
        reasoning_efforts: [
          { id: "xhigh", value: "xhigh", default: false },
          { id: "high", value: "high", default: true },
          { id: "medium", value: "medium", default: false },
          { id: "low", value: "low", default: false }
        ]
      }
    },
    "grok-4.5": {
      info: {
        reasoning_effort: "high",
        context_window: 500000,
        reasoning_efforts: [
          { id: "high", value: "high", default: true },
          { id: "medium", value: "medium", default: false },
          { id: "low", value: "low", default: false }
        ]
      }
    }
  }
};

test("model parser keeps default and ordinary model bullets", () => {
  assert.deepEqual(parseModels(MODEL_OUTPUT), {
    defaultModel: "grok-4.6",
    models: ["grok-4.6", "grok-4.5"]
  });
});

test("model catalog exposes reasoning levels per model", () => {
  const modelInfo = parseModels(MODEL_OUTPUT);
  const catalog = buildModelCapabilityCatalog({
    bridgeEfforts: ["low", "medium", "high"],
    grokVersion: "grok 1.0.13 (5e9a58528b76) [stable]",
    modelCache: MODEL_CACHE,
    modelInfo
  });

  assert.equal(catalog.source, "grok-model-cache");
  assert.deepEqual(
    catalog.models["grok-4.6"].supportedReasoningEfforts,
    ["xhigh", "high", "medium", "low"]
  );
  assert.equal(catalog.models["grok-4.6"].highestReasoningEffort, "xhigh");
  assert.deepEqual(
    catalog.models["grok-4.5"].supportedReasoningEfforts,
    ["high", "medium", "low"]
  );
  assert.equal(catalog.models["grok-4.5"].highestReasoningEffort, "high");
  assert.deepEqual(unionReasoningEfforts(catalog), [
    "low",
    "medium",
    "high",
    "xhigh"
  ]);
});

test("selection defaults to the newest model and its highest effort", () => {
  const modelInfo = parseModels(MODEL_OUTPUT);
  const catalog = buildModelCapabilityCatalog({
    bridgeEfforts: ["low", "medium", "high"],
    grokVersion: "grok 1.0.13 (5e9a58528b76) [stable]",
    modelCache: MODEL_CACHE,
    modelInfo
  });

  const model = chooseModel(modelInfo);
  assert.equal(model, "grok-4.6");
  assert.equal(chooseReasoningEffort(catalog, model), "xhigh");
  assert.equal(
    chooseReasoningEffort(catalog, "grok-4.6", "medium"),
    "medium"
  );
  assert.throws(
    () => chooseReasoningEffort(catalog, "grok-4.5", "xhigh"),
    /grok-4\.5.*high, medium, low/i
  );
});

test("stale model metadata falls back to bridge-supported effort", () => {
  const modelInfo = parseModels(MODEL_OUTPUT);
  const catalog = buildModelCapabilityCatalog({
    bridgeEfforts: ["low", "medium", "high"],
    grokVersion: "grok 1.0.14 (future) [stable]",
    modelCache: MODEL_CACHE,
    modelInfo
  });

  assert.equal(catalog.source, "official-bridge-fallback");
  assert.equal(catalog.warning, "model cache version 1.0.13 does not match Grok CLI 1.0.14");
  assert.equal(chooseReasoningEffort(catalog, "grok-4.6"), "high");
});

test("bridge overlay adds catalog efforts without editing the official source", () => {
  const source = `const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const usage = "--effort <low|medium|high>";
throw new Error("Use one of: low, medium, high.");
`;
  assert.deepEqual(parseBridgeReasoningEfforts(source), ["low", "medium", "high"]);

  const patched = patchBridgeReasoningEfforts(source, [
    "low",
    "medium",
    "high",
    "xhigh"
  ]);
  assert.deepEqual(parseBridgeReasoningEfforts(patched), [
    "low",
    "medium",
    "high",
    "xhigh"
  ]);
  assert.match(patched, /<low\|medium\|high\|xhigh>/);
  assert.match(patched, /Use one of: low, medium, high, xhigh\./);
  assert.equal(source.includes("xhigh"), false);
  assert.throws(
    () => patchBridgeReasoningEfforts("const other = true;", ["high"]),
    /VALID_REASONING_EFFORTS/
  );
});
