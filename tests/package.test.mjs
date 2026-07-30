import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
