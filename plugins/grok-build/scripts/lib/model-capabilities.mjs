const EFFORT_RANK = new Map([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6]
]);

function unique(values) {
  return [...new Set(values)];
}

function normalizeEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function runtimeVersion(value) {
  return String(value).match(/\bgrok\s+(\d+\.\d+\.\d+)\b/i)?.[1] ?? null;
}

function highestRanked(efforts) {
  return efforts.reduce((highest, effort) => {
    if (highest == null) return effort;
    const currentRank = EFFORT_RANK.get(effort) ?? -1;
    const highestRank = EFFORT_RANK.get(highest) ?? -1;
    return currentRank > highestRank ? effort : highest;
  }, null);
}

export function parseModels(output) {
  const models = [];
  let defaultModel = null;
  let inModels = false;
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const defaultMatch = line.match(/^Default model:\s*(\S+)/i);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }
    if (/^Available models:/i.test(line)) {
      inModels = true;
      continue;
    }
    if (!inModels || !line) continue;
    const modelMatch = line.match(
      /^(?:[*-]\s*)?([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+\(default\))?$/
    );
    if (!modelMatch) continue;
    models.push(modelMatch[1]);
    if (line.startsWith("*") || /\(default\)\s*$/.test(line)) {
      defaultModel = modelMatch[1];
    }
  }
  return { defaultModel, models: unique(models) };
}

function numericModelParts(model) {
  const match = String(model).match(/^grok-(\d+(?:\.\d+)*)$/i);
  return match ? match[1].split(".").map(Number) : null;
}

function compareNumberArrays(left, right) {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function chooseModel(modelInfo, override = null) {
  if (override) {
    if (modelInfo.models.length > 0 && !modelInfo.models.includes(override)) {
      throw new Error("Requested model is not available: " + override);
    }
    return override;
  }
  const flagship = modelInfo.models
    .map((model) => ({ model, parts: numericModelParts(model) }))
    .filter((entry) => entry.parts)
    .sort((left, right) => compareNumberArrays(right.parts, left.parts));
  return flagship[0]?.model ||
    modelInfo.defaultModel ||
    modelInfo.models[0] ||
    null;
}

function cacheEfforts(info) {
  if (!Array.isArray(info?.reasoning_efforts)) return [];
  return unique(info.reasoning_efforts
    .map((entry) => normalizeEffort(entry?.value ?? entry?.id))
    .filter(Boolean));
}

function fallbackCapability(bridgeEfforts) {
  const efforts = unique(bridgeEfforts.map(normalizeEffort).filter(Boolean));
  const highest = highestRanked(efforts);
  return {
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: highest,
    highestReasoningEffort: highest,
    contextWindow: null,
    source: "official-bridge"
  };
}

export function buildModelCapabilityCatalog({
  bridgeEfforts,
  grokVersion,
  modelCache,
  modelInfo
}) {
  const currentVersion = runtimeVersion(grokVersion);
  const cacheVersion = typeof modelCache?.grok_version === "string"
    ? modelCache.grok_version
    : null;
  const versionMatches = Boolean(currentVersion && cacheVersion === currentVersion);
  const models = {};
  const missing = [];

  for (const model of modelInfo.models) {
    const info = versionMatches ? modelCache?.models?.[model]?.info : null;
    const efforts = cacheEfforts(info);
    if (efforts.length === 0) {
      models[model] = fallbackCapability(bridgeEfforts);
      missing.push(model);
      continue;
    }
    const declaredDefault = normalizeEffort(info.reasoning_effort) ||
      normalizeEffort(info.reasoning_efforts.find((entry) => entry?.default)?.value);
    models[model] = {
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: efforts.includes(declaredDefault)
        ? declaredDefault
        : efforts[0],
      // The Grok model catalog currently orders reasoning_efforts from highest
      // to lowest. Preserve that model-owned ordering so future named levels
      // do not need an adapter release merely to outrank today's xhigh.
      highestReasoningEffort: efforts[0],
      contextWindow: Number.isFinite(info.context_window)
        ? info.context_window
        : null,
      source: "grok-model-cache"
    };
  }

  let source = "grok-model-cache";
  let warning = null;
  if (!versionMatches) {
    source = "official-bridge-fallback";
    warning = currentVersion && cacheVersion
      ? `model cache version ${cacheVersion} does not match Grok CLI ${currentVersion}`
      : "model cache version could not be verified against the Grok CLI";
  } else if (missing.length > 0) {
    source = "grok-model-cache-partial";
    warning = "model cache is missing capabilities for: " + missing.join(", ");
  }

  return {
    source,
    warning,
    fetchedAt: modelCache?.fetched_at ?? null,
    grokVersion: cacheVersion,
    models
  };
}

export function chooseReasoningEffort(catalog, model, override = null) {
  const capability = catalog.models[model];
  if (!capability) {
    throw new Error("No reasoning capability metadata is available for model " + model + ".");
  }
  const supported = capability.supportedReasoningEfforts;
  const requested = normalizeEffort(override);
  if (requested && !supported.includes(requested)) {
    throw new Error(
      `Reasoning effort ${requested} is not supported by ${model}. Supported: ` +
      supported.join(", ")
    );
  }
  const selected = requested || capability.highestReasoningEffort;
  if (!selected) {
    throw new Error("No reasoning effort is available for model " + model + ".");
  }
  return selected;
}

export function unionReasoningEfforts(catalog) {
  const discovered = unique(Object.values(catalog.models)
    .flatMap((entry) => entry.supportedReasoningEfforts));
  return discovered.sort((left, right) => {
    const leftRank = EFFORT_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = EFFORT_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

export function parseBridgeReasoningEfforts(source) {
  const match = String(source).match(
    /VALID_REASONING_EFFORTS\s*=\s*new Set\(\[([^\]]+)\]\)/s
  );
  if (!match) return [];
  return unique([...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((item) => normalizeEffort(item[1]))
    .filter(Boolean));
}

export function patchBridgeReasoningEfforts(source, requestedEfforts) {
  const nativeEfforts = parseBridgeReasoningEfforts(source);
  if (nativeEfforts.length === 0) {
    throw new Error("Official bridge has no recognizable VALID_REASONING_EFFORTS set.");
  }
  const efforts = unique(requestedEfforts.map(normalizeEffort).filter(Boolean));
  if (efforts.length === 0 || efforts.some((effort) => !/^[a-z][a-z0-9_-]*$/.test(effort))) {
    throw new Error("Reasoning effort catalog contains an invalid value.");
  }
  const serialized = efforts.map((effort) => JSON.stringify(effort)).join(", ");
  let patched = String(source).replace(
    /VALID_REASONING_EFFORTS\s*=\s*new Set\(\[[^\]]+\]\)/s,
    `VALID_REASONING_EFFORTS = new Set([${serialized}])`
  );
  patched = patched.replaceAll(
    `<${nativeEfforts.join("|")}>`,
    `<${efforts.join("|")}>`
  );
  patched = patched.replaceAll(
    `Use one of: ${nativeEfforts.join(", ")}.`,
    `Use one of: ${efforts.join(", ")}.`
  );
  return patched;
}
