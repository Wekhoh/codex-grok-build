import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanBridge,
  assertSafeProjectPolicy,
  buildDirectSafetyArgs,
  createChildEnvironment,
  hasOption,
  isVerifiedStableCli,
  resolveCommandCapabilities,
  resolveTrustedExecutable,
  singleOptionValue,
  shouldInstallStable
} from "../plugins/grok-build/scripts/lib/runtime-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "grok-build");
const adapter = path.join(pluginRoot, "scripts", "grok-codex.mjs");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(target));
    } else {
      files.push(target);
    }
  }
  return files;
}

test("plugin manifest and marketplace agree", () => {
  const manifest = readJson(
    path.join(pluginRoot, ".codex-plugin", "plugin.json")
  );
  const marketplace = readJson(
    path.join(root, ".agents", "plugins", "marketplace.json")
  );
  const entry = marketplace.plugins.find(
    (plugin) => plugin.name === manifest.name
  );

  assert.equal(manifest.name, "grok-build");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.skills, "./skills/");
  assert.ok(entry, "marketplace entry is missing");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./plugins/grok-build");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(manifest.version, readJson(path.join(root, "package.json")).version);
});

test("bundled paths exist and stay inside the plugin", () => {
  const manifest = readJson(
    path.join(pluginRoot, ".codex-plugin", "plugin.json")
  );
  const skills = path.resolve(pluginRoot, manifest.skills);

  assert.equal(path.relative(pluginRoot, skills).startsWith(".."), false);
  assert.equal(fs.existsSync(skills), true);
  assert.equal(
    fs.existsSync(path.join(skills, "grok-build", "SKILL.md")),
    true
  );
  assert.equal(fs.existsSync(adapter), true);
});

test("adapter parses and exposes the expected command surface", () => {
  const syntax = spawnSync(process.execPath, ["--check", adapter], {
    encoding: "utf8"
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync(process.execPath, [adapter, "--help"], {
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  for (const command of [
    "sync",
    "capabilities",
    "check",
    "review",
    "critique",
    "runs",
    "show",
    "stop",
    "import",
    "direct"
  ]) {
    assert.match(help.stdout, new RegExp("\\b" + command + "\\b"));
  }
});

test("published plugin contains no developer-specific absolute path", () => {
  const text = walk(pluginRoot)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  assert.doesNotMatch(text, /C:\\Users\\/i);
  assert.doesNotMatch(text, /Users\/jackl/i);
});

test("README uses the current Codex marketplace command surface", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  assert.match(
    readme,
    /codex plugin marketplace add Wekhoh\/codex-grok-build/
  );
  assert.match(
    readme,
    /codex plugin add grok-build@codex-grok-build/
  );
  assert.doesNotMatch(readme, /codex plugin install/);
});

test("trusted executable resolution ignores cwd and relative PATH entries", () => {
  const sandbox = fs.mkdtempSync(path.join(process.env.TEMP || root, "grok-policy-"));
  const cwd = path.join(sandbox, "repo");
  fs.mkdirSync(cwd);
  const executable = path.basename(process.execPath);
  const command = process.platform === "win32"
    ? path.basename(executable, path.extname(executable))
    : executable;
  fs.writeFileSync(path.join(cwd, executable), "rogue");

  const resolved = resolveTrustedExecutable(command, {
    cwd,
    env: {
      PATH: [".", path.dirname(process.execPath)].join(path.delimiter),
      PATHEXT: ".EXE;.CMD"
    }
  });

  assert.equal(
    process.platform === "win32" ? resolved.toLowerCase() : resolved,
    process.platform === "win32"
      ? fs.realpathSync(process.execPath).toLowerCase()
      : fs.realpathSync(process.execPath)
  );
  const launched = spawnSync(resolved, ["--version"], { encoding: "utf8" });
  assert.equal(launched.status, 0, launched.error?.message || launched.stderr);
  if (process.platform === "win32") {
    const shim = path.join(cwd, "shim.cmd");
    fs.writeFileSync(shim, "@echo unsafe");
    assert.throws(
      () => resolveTrustedExecutable(shim),
      /not runnable/
    );
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("child environment drops unrelated credentials by default", () => {
  const absoluteBin = path.resolve(root, "trusted-bin");
  const source = {
    PATH: [".", absoluteBin].join(path.delimiter),
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\demo",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    XAI_API_KEY: "xai-secret"
  };

  const safe = createChildEnvironment(source);
  assert.equal(safe.PATH, absoluteBin);
  assert.equal(safe.SystemRoot, "C:\\Windows");
  assert.equal(safe.GITHUB_TOKEN, undefined);
  assert.equal(safe.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(safe.XAI_API_KEY, undefined);

  const xaiOptIn = createChildEnvironment(source, { forwardXaiApiKey: true });
  assert.equal(xaiOptIn.XAI_API_KEY, "xai-secret");
});

test("direct mode enforces safe permission boundaries", () => {
  assert.deepEqual(buildDirectSafetyArgs([], { write: false }), [
    "--permission-mode",
    "plan",
    "--sandbox",
    "read-only"
  ]);
  assert.throws(
    () => buildDirectSafetyArgs(
      ["--permission-mode", "bypassPermissions"],
      { write: false }
    ),
    /requires --write/
  );
  assert.throws(
    () => buildDirectSafetyArgs(["--always-approve"], { write: false }),
    /unsafe-always-approve/
  );
  for (const args of [
    ["--yolo"],
    ["--yolo=true"],
    ["--dangerously-skip-permissions"],
    ["--allow", "**"],
    ["--allow=**"],
    ["--allowedTools", "shell(*)"]
  ]) {
    assert.throws(
      () => buildDirectSafetyArgs(args, { write: true }),
      /unsafe-always-approve/
    );
  }
  assert.deepEqual(buildDirectSafetyArgs([], { write: true }), [
    "--permission-mode",
    "acceptEdits",
    "--sandbox",
    "workspace"
  ]);
  assert.deepEqual(
    buildDirectSafetyArgs([], { write: true, unsafeAlwaysApprove: true }),
    [
      "--permission-mode",
      "acceptEdits",
      "--sandbox",
      "workspace",
      "--always-approve"
    ]
  );
  assert.throws(
    () => buildDirectSafetyArgs([], {
      write: false,
      unsafeAlwaysApprove: true
    }),
    /requires --write/
  );
  for (const args of [
    ["--worktree"],
    ["--worktree=review"],
    ["-w"],
    ["-w=review"],
    ["-wreview"],
    ["-cwfoo"],
    ["-cwf"],
    ["--debug-file", "debug.log"],
    ["--debug-file=debug.log"]
  ]) {
    assert.throws(
      () => buildDirectSafetyArgs(args, { write: false }),
      /not supported/
    );
  }
  assert.throws(
    () => buildDirectSafetyArgs(["--worktree"], { write: true }),
    /not supported/
  );
  assert.throws(
    () => buildDirectSafetyArgs(["--debug-file=debug.log"], { write: true }),
    /not supported/
  );
  assert.throws(
    () => buildDirectSafetyArgs(["--restore-code"], { write: true }),
    /not supported/
  );
  for (const args of [
    ["wrap", "powershell"],
    ["worktree", "add"],
    ["plugin", "install"],
    ["update", "--alpha"]
  ]) {
    assert.throws(
      () => buildDirectSafetyArgs(args, { write: true }),
      /management subcommand is not supported/
    );
  }
  assert.doesNotThrow(() => buildDirectSafetyArgs(
    ["--cwd", "worktree", "-p", "Return a result."],
    { write: false }
  ));
  assert.doesNotThrow(() => buildDirectSafetyArgs(
    ["-p", "-whatever"],
    { write: false }
  ));
});

test("boolean option detection rejects inline bridge write forms", () => {
  assert.equal(hasOption(["--write"], "write"), true);
  assert.equal(hasOption(["--write=true"], "write"), true);
  assert.equal(hasOption(["--write=1"], "write"), true);
  assert.equal(hasOption(["--write=0"], "write"), true);
  assert.equal(hasOption(["--write=false"], "write"), true);
  assert.equal(hasOption(["--writer"], "write"), false);
});

test("safe write rejects untrusted projects and project permission rules", () => {
  const projectRoot = path.resolve(root, "fixture-project");
  const globalSource = path.resolve(root, "..", "global-settings.json");
  const projectSource = path.join(projectRoot, ".grok", "config.toml");
  assert.doesNotThrow(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: true,
    permissions: { sources: [globalSource + " (settings)"] }
  }));
  assert.throws(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: true,
    permissions: { sources: [projectSource + " (settings)"] }
  }), /project-level permission rules/i);
  assert.throws(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: true,
    permissions: { sources: [path.join(".grok", "config.toml")] }
  }), /project-level permission rules/i);
  assert.throws(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: false,
    permissions: { sources: [] }
  }), /not trusted/i);
  assert.throws(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: true
  }), /permission sources/i);
  assert.throws(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: true,
    permissions: { sources: [{ unknown: true }] }
  }), /permission source format/i);
  assert.doesNotThrow(() => assertSafeProjectPolicy({
    projectRoot,
    projectTrusted: false,
    permissions: { sources: [projectSource] }
  }, { unsafeAlwaysApprove: true }));
});

test("single option parsing cannot be redirected by duplicates", () => {
  assert.equal(singleOptionValue(["--cwd", "repo"], "cwd"), "repo");
  assert.equal(singleOptionValue(["--cwd=repo"], "cwd"), "repo");
  assert.equal(singleOptionValue([], "cwd"), null);
  assert.throws(
    () => singleOptionValue(["--cwd", "safe", "--cwd=unsafe"], "cwd"),
    /at most once/
  );
});

test("bridge and stable-channel policies fail closed", () => {
  assert.doesNotThrow(() => assertCleanBridge(""));
  assert.throws(() => assertCleanBridge(" M scripts/grok-bridge.mjs"), /dirty/i);
  assert.equal(shouldInstallStable({ channel: "stable", updateAvailable: false }), false);
  assert.equal(shouldInstallStable({ channel: "alpha", updateAvailable: false }), true);
  assert.equal(shouldInstallStable({ channel: "stable", updateAvailable: true }), true);
  assert.equal(shouldInstallStable({ updateAvailable: false }), true);
  assert.equal(isVerifiedStableCli({
    channel: "stable",
    version: "grok 1.2.3"
  }, "grok 1.2.3"), true);
  assert.equal(isVerifiedStableCli({
    channel: "alpha",
    version: "grok 1.2.3"
  }, "grok 1.2.3"), false);
  assert.equal(isVerifiedStableCli({
    channel: "stable",
    version: "grok 1.2.2"
  }, "grok 1.2.3"), false);
});

test("sync capability resolution honors explicit overrides exactly once", () => {
  const calls = [];
  const overrides = { model: "grok-4.5", effort: "high" };
  const result = resolveCommandCapabilities({
    noSync: false,
    overrides,
    sync: (received) => {
      calls.push(["sync", received]);
      return { capabilities: { selectedModel: received.model } };
    },
    probe: () => {
      calls.push(["probe"]);
      return {};
    }
  });

  assert.equal(result.selectedModel, "grok-4.5");
  assert.deepEqual(calls, [["sync", overrides]]);
});

test("GitHub Actions are pinned to immutable commits", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+\b/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
});
