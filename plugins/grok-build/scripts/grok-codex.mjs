#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import {
  digestTrackedTree,
  materializeTrackedSnapshot,
  parseTrackedTree
} from "./lib/bridge-snapshot.mjs";
import {
  assertCleanBridge,
  assertSafeProjectPolicy,
  buildDirectSafetyArgs,
  createChildEnvironment,
  extractCapabilityOverrides,
  hasOption,
  isVerifiedStableCli,
  resolveCommandCapabilities,
  resolveTrustedExecutable,
  singleOptionValue,
  shouldInstallStable
} from "./lib/runtime-policy.mjs";
import {
  buildModelCapabilityCatalog,
  chooseModel,
  chooseReasoningEffort,
  parseBridgeReasoningEfforts,
  parseModels,
  patchBridgeReasoningEfforts,
  unionReasoningEfforts
} from "./lib/model-capabilities.mjs";

const OFFICIAL_REPOSITORY = "https://github.com/xai-org/grok-build-plugin-cc.git";
const GROK_BINARY_REQUEST = process.env.GROK_BINARY || "grok";
const VENDOR_REPOSITORY = process.env.GROK_BUILD_REPOSITORY ||
  path.join(os.homedir(), ".codex", "vendor", "grok-build-plugin-cc");
const BRIDGE_ROOT = path.join(VENDOR_REPOSITORY, "plugins", "grok-build");
const BRIDGE_SCRIPT = path.join(BRIDGE_ROOT, "scripts", "grok-bridge.mjs");
const BRIDGE_GIT_ROOT = "plugins/grok-build";
const PLUGIN_DATA_ROOT = process.env.GROK_BUILD_PLUGIN_DATA ||
  path.join(os.homedir(), ".codex", "plugin-data", "grok-build");
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const MODEL_CACHE_FILE = process.env.GROK_MODEL_CACHE_FILE ||
  path.join(GROK_HOME, "models_cache.json");
const BRIDGE_RUNTIME_ROOT = path.join(PLUGIN_DATA_ROOT, "bridge-runtimes");
const CLI_VERIFICATION_FILE = path.join(
  PLUGIN_DATA_ROOT,
  "cli-verification.json"
);
const PROXY_COMMANDS = new Set(["run", "review", "critique"]);
const STATE_COMMANDS = new Set(["runs", "show", "stop", "import"]);
const requestedTimeout = Number.parseInt(
  process.env.GROK_BUILD_COMMAND_TIMEOUT_MS || "120000",
  10
);
const COMMAND_TIMEOUT_MS = Number.isSafeInteger(requestedTimeout) &&
  requestedTimeout > 0
  ? requestedTimeout
  : 120000;

let resolvedGitBinary = null;
let resolvedGrokBinary = null;
const bridgeBlobCache = new Map();

class UpdatePolicyError extends Error {}

function gitBinary() {
  resolvedGitBinary ||= resolveTrustedExecutable("git");
  return resolvedGitBinary;
}

function grokBinary() {
  if (process.env.GROK_BINARY && !path.isAbsolute(process.env.GROK_BINARY)) {
    throw new Error("GROK_BINARY must be an absolute executable path.");
  }
  resolvedGrokBinary ||= resolveTrustedExecutable(GROK_BINARY_REQUEST);
  return resolvedGrokBinary;
}

function childEnvironment(extra = {}) {
  return {
    ...createChildEnvironment(process.env, {
      forwardXaiApiKey:
        process.env.GROK_BUILD_FORWARD_XAI_API_KEY === "1"
    }),
    ...(process.platform === "win32"
      ? { NoDefaultCurrentDirectoryInExePath: "1" }
      : {}),
    ...extra
  };
}

function fail(message, code = 1) {
  process.stderr.write(String(message) + "\n");
  process.exit(code);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || childEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS
  });
  return {
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
    signal: result.signal || null
  };
}

function checkedBuffer(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || childEnvironment(),
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8") ||
      result.stdout?.toString("utf8") ||
      command + (result.signal
        ? " terminated by " + result.signal
        : " exited " + result.status);
    throw new Error(detail.trim());
  }
  return Buffer.from(result.stdout || []);
}

function checked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout ||
      command + (result.signal
        ? " terminated by " + result.signal
        : " exited " + result.status);
    throw new Error(detail.trim());
  }
  return result.stdout.trim();
}

function parseJsonOutput(value) {
  const text = String(value).trim();
  try {
    return JSON.parse(text);
  } catch {
    // Some CLI versions print a human-readable prefix before one JSON line.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep looking for the machine-readable line.
    }
  }
  throw new Error("Command did not return valid JSON.");
}

function takeSwitch(args, name) {
  const target = "--" + name;
  const index = args.indexOf(target);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function ensureVendorRepository() {
  if (!fs.existsSync(VENDOR_REPOSITORY)) {
    fs.mkdirSync(path.dirname(VENDOR_REPOSITORY), { recursive: true });
    checked(gitBinary(), [
      "clone",
      "--filter=blob:none",
      OFFICIAL_REPOSITORY,
      VENDOR_REPOSITORY
    ]);
  }

  const remote = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "remote",
    "get-url",
    "origin"
  ]);
  const normalized = remote.replace(/\.git$/, "").toLowerCase();
  const expected = OFFICIAL_REPOSITORY.replace(/\.git$/, "").toLowerCase();
  if (normalized !== expected) {
    throw new UpdatePolicyError(
      "Refusing to update unexpected Grok bridge origin: " +
      redactRemote(remote)
    );
  }
  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    throw new UpdatePolicyError(
      "Official Grok bridge is missing: " + BRIDGE_SCRIPT
    );
  }
}

function redactRemote(remote) {
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<non-standard remote>";
  }
}

function verifyBridgeCheckout() {
  ensureVendorRepository();
  const head = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "rev-parse",
    "HEAD"
  ]);
  const dirty = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "status",
    "--porcelain"
  ]);
  assertCleanBridge(dirty, UpdatePolicyError);

  const branchResult = run(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD"
  ]);
  const branch = branchResult.status === 0
    ? branchResult.stdout.trim()
    : "";
  if (branch !== "main") {
    throw new UpdatePolicyError(
      "Refusing to update Grok bridge from branch " +
      (branch || "detached HEAD") +
      "; expected main."
    );
  }

  const remoteHead = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "rev-parse",
    "origin/main"
  ]);
  const ancestry = run(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "merge-base",
    "--is-ancestor",
    head,
    remoteHead
  ]);
  if (ancestry.status !== 0) {
    throw new UpdatePolicyError(
      "Official Grok bridge HEAD is not a verified ancestor of origin/main."
    );
  }
  return { head, branch, remoteHead };
}

function syncBridge() {
  const verified = verifyBridgeCheckout();
  const before = verified.head;

  checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "fetch",
    "--prune",
    "origin"
  ]);
  const remoteHead = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "rev-parse",
    "origin/main"
  ]);
  const ancestry = run(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "merge-base",
    "--is-ancestor",
    before,
    remoteHead
  ]);
  if (ancestry.status !== 0) {
    throw new UpdatePolicyError(
      "Official Grok bridge history diverged; refusing a non-fast-forward update."
    );
  }
  if (before !== remoteHead) {
    checked(gitBinary(), [
      "-C",
      VENDOR_REPOSITORY,
      "merge",
      "--ff-only",
      remoteHead
    ]);
  }
  const after = verifyBridgeCheckout().head;
  return {
    before,
    after,
    updated: before !== after,
    skipped: null
  };
}

function syncCli() {
  let check = parseJsonOutput(
    checked(grokBinary(), ["update", "--check", "--json"])
  );
  let installed = false;
  if (shouldInstallStable(check)) {
    try {
      checked(grokBinary(), ["update", "--stable"]);
    } catch (error) {
      if (check.channel !== "stable") {
        throw new UpdatePolicyError(
          "Could not switch Grok CLI to the stable channel: " + error.message
        );
      }
      throw error;
    }
    installed = true;
    check = parseJsonOutput(
      checked(grokBinary(), ["update", "--check", "--json"])
    );
  }
  if (check.channel !== "stable") {
    throw new UpdatePolicyError(
      "Grok CLI did not report the stable update channel."
    );
  }
  const version = checked(grokBinary(), ["--version"]);
  fs.mkdirSync(PLUGIN_DATA_ROOT, { recursive: true });
  fs.writeFileSync(
    CLI_VERIFICATION_FILE,
    JSON.stringify({ channel: "stable", version }, null, 2) + "\n",
    "utf8"
  );
  return { ...check, installed, version };
}

function verifiedOfflineCli(updateError) {
  const version = checked(grokBinary(), ["--version"]);
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(CLI_VERIFICATION_FILE, "utf8"));
  } catch {
    // A missing or unreadable record is not verified local state.
  }
  if (!isVerifiedStableCli(record, version)) {
    throw new UpdatePolicyError(
      "CLI update check failed and the installed Grok version has no " +
      "matching stable-channel verification record: " + updateError.message
    );
  }
  return {
    channel: "stable",
    installed: false,
    offline: true,
    version
  };
}

function bridgeEfforts(source) {
  const efforts = parseBridgeReasoningEfforts(source);
  return efforts.length > 0 ? efforts : ["high"];
}

function loadModelCache() {
  if (process.env.GROK_MODEL_CACHE_FILE && !path.isAbsolute(MODEL_CACHE_FILE)) {
    throw new Error("GROK_MODEL_CACHE_FILE must be an absolute path.");
  }
  try {
    return {
      cache: JSON.parse(fs.readFileSync(MODEL_CACHE_FILE, "utf8")),
      warning: null
    };
  } catch (error) {
    return {
      cache: null,
      warning: "Grok model cache could not be read: " + error.message
    };
  }
}

function trackedBridgeEntries(commit) {
  const output = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    BRIDGE_GIT_ROOT
  ]);
  const entries = parseTrackedTree(output, BRIDGE_GIT_ROOT);
  if (!entries.some((entry) => entry.relative === "scripts/grok-bridge.mjs")) {
    throw new UpdatePolicyError(
      "The pinned official bridge commit does not contain grok-bridge.mjs."
    );
  }
  return entries;
}

function bridgeBlobContent(entry) {
  if (bridgeBlobCache.has(entry.object)) {
    return bridgeBlobCache.get(entry.object);
  }
  const content = checkedBuffer(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "cat-file",
    "blob",
    entry.object
  ]);
  const actualObject = checked(gitBinary(), [
    "-C",
    VENDOR_REPOSITORY,
    "hash-object",
    "--stdin"
  ], { input: content });
  if (actualObject.toLowerCase() !== entry.object.toLowerCase()) {
    throw new UpdatePolicyError(
      "Official Grok bridge blob failed object-hash verification: " +
      entry.relative
    );
  }
  bridgeBlobCache.set(entry.object, content);
  return content;
}

function bridgeScriptEntry(entries) {
  const entry = entries.find(
    (candidate) => candidate.relative === "scripts/grok-bridge.mjs"
  );
  if (!entry) {
    throw new UpdatePolicyError(
      "The pinned official bridge commit does not contain grok-bridge.mjs."
    );
  }
  return entry;
}

function assertBridgeCommit(expected) {
  const verified = verifyBridgeCheckout();
  if (verified.head !== expected) {
    throw new UpdatePolicyError(
      "Official Grok bridge changed during capability resolution; retry the command."
    );
  }
}

function bridgeRuntime(capabilities) {
  assertBridgeCommit(capabilities.bridgeCommit);
  const entries = trackedBridgeEntries(capabilities.bridgeCommit);
  const officialSource = bridgeBlobContent(bridgeScriptEntry(entries))
    .toString("utf8");
  const needsCompatibilityOverlay = !capabilities.bridgeNativeReasoningEfforts.includes(
    capabilities.selectedReasoningEffort
  );
  const relativeScript = "scripts/grok-bridge.mjs";
  const runtimeSource = needsCompatibilityOverlay
    ? patchBridgeReasoningEfforts(
      officialSource,
      capabilities.pluginSupportedReasoningEfforts
    )
    : officialSource;
  const overrides = new Map([
    [relativeScript, Buffer.from(runtimeSource, "utf8")]
  ]);
  const expectedDigest = digestTrackedTree(
    entries,
    bridgeBlobContent,
    overrides
  );
  const key = capabilities.bridgeCommit + "-" + expectedDigest.slice(0, 24);
  const runtimeRoot = path.join(BRIDGE_RUNTIME_ROOT, key);
  materializeTrackedSnapshot({
    entries,
    expectedDigest,
    overrides,
    readBlob: bridgeBlobContent,
    targetRoot: runtimeRoot
  });
  assertBridgeCommit(capabilities.bridgeCommit);
  return {
    mode: needsCompatibilityOverlay
      ? "capability-overlay"
      : "verified-snapshot",
    root: runtimeRoot,
    script: path.join(runtimeRoot, "scripts", "grok-bridge.mjs"),
    digest: expectedDigest
  };
}

function getCapabilities(overrides = {}) {
  const verifiedBridge = verifyBridgeCheckout();
  const trackedEntries = trackedBridgeEntries(verifiedBridge.head);
  const officialBridgeSource = bridgeBlobContent(
    bridgeScriptEntry(trackedEntries)
  ).toString("utf8");
  const version = checked(grokBinary(), ["--version"]);
  const modelOutput = checked(grokBinary(), ["models"]);
  const modelInfo = parseModels(modelOutput);
  const nativeBridgeEfforts = bridgeEfforts(officialBridgeSource);
  const loadedModelCache = loadModelCache();
  const catalog = buildModelCapabilityCatalog({
    bridgeEfforts: nativeBridgeEfforts,
    grokVersion: version,
    modelCache: loadedModelCache.cache,
    modelInfo
  });
  const model = chooseModel(
    modelInfo,
    overrides.model || process.env.GROK_MODEL || null
  );
  if (!model) {
    throw new Error("No Grok model is available.");
  }
  const effort = chooseReasoningEffort(
    catalog,
    model,
    overrides.effort || process.env.GROK_REASONING_EFFORT || null
  );
  const capabilities = {
    ready: false,
    grokVersion: version,
    bridgeCommit: verifiedBridge.head,
    bridgeScript: BRIDGE_SCRIPT,
    pluginDataRoot: PLUGIN_DATA_ROOT,
    availableModels: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    modelCapabilities: catalog.models,
    capabilitySource: catalog.source,
    capabilityWarning: loadedModelCache.warning || catalog.warning,
    modelCatalogFile: MODEL_CACHE_FILE,
    modelCatalogFetchedAt: catalog.fetchedAt,
    bridgeNativeReasoningEfforts: nativeBridgeEfforts,
    pluginSupportedReasoningEfforts: unionReasoningEfforts(catalog),
    selectedModel: model,
    supportedReasoningEfforts:
      catalog.models[model].supportedReasoningEfforts,
    selectedReasoningEffort: effort
  };
  capabilities.bridgeRuntime = bridgeRuntime(capabilities);
  capabilities.ready = true;
  return capabilities;
}

function printCapabilityWarning(capabilities) {
  if (capabilities.capabilityWarning) {
    process.stderr.write(
      "[grok-build] warning: " + capabilities.capabilityWarning + "\n"
    );
  }
}

function syncAll(overrides = {}) {
  const result = {
    ready: false,
    cli: null,
    bridge: null,
    warnings: []
  };
  try {
    result.cli = syncCli();
  } catch (error) {
    if (error instanceof UpdatePolicyError) {
      throw error;
    }
    result.cli = verifiedOfflineCli(error);
    result.warnings.push("CLI update check failed: " + error.message);
  }
  try {
    result.bridge = syncBridge();
  } catch (error) {
    if (error instanceof UpdatePolicyError) {
      throw error;
    }
    result.warnings.push("Bridge update check failed: " + error.message);
  }
  const capabilities = getCapabilities(overrides);
  if (capabilities.capabilityWarning) {
    result.warnings.push(capabilities.capabilityWarning);
  }
  result.ready = capabilities.ready;
  result.capabilities = capabilities;
  return result;
}

function syncForCommand(overrides = {}) {
  const result = syncAll(overrides);
  for (const warning of result.warnings) {
    process.stderr.write("[grok-build] warning: " + warning + "\n");
  }
  return result;
}

function passthrough(command, args, env = childEnvironment()) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: false
  });
  child.on("error", (error) => fail(error.message));
  child.on("close", (code) => process.exit(code ?? 1));
}

function bridgeEnvironment(bridgeRoot = BRIDGE_ROOT) {
  fs.mkdirSync(PLUGIN_DATA_ROOT, { recursive: true });
  return childEnvironment({
    GROK_BINARY: grokBinary(),
    PLUGIN_ROOT: bridgeRoot,
    PLUGIN_DATA: PLUGIN_DATA_ROOT,
    CLAUDE_PLUGIN_ROOT: bridgeRoot,
    CLAUDE_PLUGIN_DATA: PLUGIN_DATA_ROOT
  });
}

function verifySafeWriteProject(args, unsafeAlwaysApprove) {
  if (unsafeAlwaysApprove) {
    return;
  }
  const requestedCwd = singleOptionValue(args, "cwd");
  const targetCwd = path.resolve(requestedCwd || process.cwd());
  const inspect = parseJsonOutput(
    checked(grokBinary(), ["--cwd", targetCwd, "inspect", "--json"])
  );
  assertSafeProjectPolicy(inspect);
}

function printUsage() {
  process.stdout.write([
    "Usage:",
    "  grok-codex.mjs sync [--json]",
    "  grok-codex.mjs capabilities [--no-sync] [--json] [--model <id>] [--effort <level>]",
    "  grok-codex.mjs check [--no-sync] [--json]",
    "  grok-codex.mjs run|review|critique [--no-sync] [bridge options]",
    "  grok-codex.mjs runs|show|stop|import [bridge options]",
    "  grok-codex.mjs direct [--no-sync] [--write] [--unsafe-always-approve] [native grok options]",
    "",
    "Defaults use the newest grok models entry and that model's highest advertised effort.",
    "Set GROK_MODEL or GROK_REASONING_EFFORT for an explicit override.",
    ""
  ].join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const noSync = takeSwitch(args, "no-sync");
  const asJson = takeSwitch(args, "json");

  if (command === "sync") {
    const result = syncAll();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (command === "capabilities") {
    const overrides = extractCapabilityOverrides(args);
    args.splice(0, args.length, ...overrides.args);
    if (args.length > 0) {
      throw new Error("Unknown capabilities arguments: " + args.join(" "));
    }
    const result = resolveCommandCapabilities({
      noSync,
      overrides,
      sync: syncForCommand,
      probe: getCapabilities
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (command === "check") {
    const capabilities = resolveCommandCapabilities({
      noSync,
      overrides: {},
      sync: syncForCommand,
      probe: getCapabilities
    });
    const runtime = bridgeRuntime(capabilities);
    const bridgeCheck = run(
      process.execPath,
      [runtime.script, "check", "--json"],
      { env: bridgeEnvironment(runtime.root) }
    );
    if (bridgeCheck.status !== 0) {
      throw new Error((bridgeCheck.stderr || bridgeCheck.stdout).trim());
    }
    const result = {
      capabilities,
      bridgeRuntime: runtime,
      bridge: JSON.parse(bridgeCheck.stdout)
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (PROXY_COMMANDS.has(command)) {
    if (command === "run" && hasOption(args, "write")) {
      throw new Error(
        "The official bridge write mode auto-approves tools. " +
        "Use direct --write for workspace-bounded implementation."
      );
    }
    const overrides = extractCapabilityOverrides(args);
    args.splice(0, args.length, ...overrides.args);
    const capabilities = resolveCommandCapabilities({
      noSync,
      overrides,
      sync: syncForCommand,
      probe: getCapabilities
    });
    const runtime = bridgeRuntime(capabilities);
    if (noSync) printCapabilityWarning(capabilities);
    process.stderr.write(
      "[grok-build] model=" +
      capabilities.selectedModel +
      " effort=" +
      capabilities.selectedReasoningEffort +
      " cli=" +
      capabilities.grokVersion +
      " bridge=" +
      capabilities.bridgeCommit.slice(0, 12) +
      " bridge_mode=" +
      runtime.mode +
      "\n"
    );
    passthrough(
      process.execPath,
      [
        runtime.script,
        command,
        "--model",
        capabilities.selectedModel,
        "--effort",
        capabilities.selectedReasoningEffort,
        ...(asJson ? ["--json"] : []),
        ...args
      ],
      bridgeEnvironment(runtime.root)
    );
    return;
  }

  if (STATE_COMMANDS.has(command)) {
    verifyBridgeCheckout();
    passthrough(
      process.execPath,
      [
        BRIDGE_SCRIPT,
        command,
        ...(asJson ? ["--json"] : []),
        ...args
      ],
      bridgeEnvironment()
    );
    return;
  }

  if (command === "direct") {
    const write = takeSwitch(args, "write");
    const unsafeAlwaysApprove = takeSwitch(args, "unsafe-always-approve");
    const overrides = extractCapabilityOverrides(args, { direct: true });
    args.splice(0, args.length, ...overrides.args);
    const safetyArgs = buildDirectSafetyArgs(args, {
      write,
      unsafeAlwaysApprove
    });
    if (write) {
      verifySafeWriteProject(args, unsafeAlwaysApprove);
    }
    const capabilities = resolveCommandCapabilities({
      noSync,
      overrides,
      sync: syncForCommand,
      probe: getCapabilities
    });
    if (noSync) printCapabilityWarning(capabilities);
    const nativeArgs = [
      "--model",
      capabilities.selectedModel,
      "--reasoning-effort",
      capabilities.selectedReasoningEffort,
      "--no-auto-update",
      ...safetyArgs,
      ...(asJson ? ["--output-format", "json"] : []),
      ...args
    ];
    process.stderr.write(
      "[grok-build] direct model=" +
      capabilities.selectedModel +
      " effort=" +
      capabilities.selectedReasoningEffort +
      " cli=" +
      capabilities.grokVersion +
      " bridge=" +
      capabilities.bridgeCommit.slice(0, 12) +
      "\n"
    );
    passthrough(grokBinary(), nativeArgs);
    return;
  }

  throw new Error("Unknown command: " + command);
}

main().catch((error) => fail("[grok-build] " + error.message));
