import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  digestTrackedTree,
  materializeTrackedSnapshot,
  parseTrackedTree
} from "../plugins/grok-build/scripts/lib/bridge-snapshot.mjs";

test("tracked tree parser rejects links and keeps only the requested root", () => {
  const parsed = parseTrackedTree(
    "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tplugins/grok-build/scripts/grok-bridge.mjs\0" +
    "100755 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tplugins/grok-build/hooks/run.sh\0",
    "plugins/grok-build"
  );
  assert.deepEqual(parsed.map((entry) => entry.relative), [
    "hooks/run.sh",
    "scripts/grok-bridge.mjs"
  ]);
  assert.throws(
    () => parseTrackedTree(
      "120000 blob cccccccccccccccccccccccccccccccccccccccc\tplugins/grok-build/scripts/link.mjs\0",
      "plugins/grok-build"
    ),
    /symbolic link/i
  );
});

test("bridge snapshots copy only tracked files and verify the patched tree", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-"));
  const target = path.join(sandbox, "snapshots", "verified");
  const object = "a".repeat(40);
  const entries = [{
    mode: "100644",
    object,
    relative: "scripts/grok-bridge.mjs"
  }];
  const readBlob = (entry) => {
    assert.equal(entry.object, object);
    return Buffer.from("official\n");
  };
  const overrides = new Map([
    ["scripts/grok-bridge.mjs", Buffer.from("patched\n")]
  ]);
  const expectedDigest = digestTrackedTree(entries, readBlob, overrides);

  try {
    assert.equal(materializeTrackedSnapshot({
      entries,
      expectedDigest,
      overrides,
      readBlob,
      targetRoot: target
    }), expectedDigest);
    assert.equal(
      fs.readFileSync(path.join(target, "scripts", "grok-bridge.mjs"), "utf8"),
      "patched\n"
    );
    assert.equal(fs.existsSync(path.join(target, "ignored.env")), false);

    fs.writeFileSync(path.join(target, "unexpected.log"), "contamination\n");
    assert.throws(() => materializeTrackedSnapshot({
      entries,
      expectedDigest,
      overrides,
      readBlob,
      targetRoot: target
    }), /does not match/i);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("failed snapshot construction cleans its staging directory", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-fail-"));
  const targetParent = path.join(sandbox, "snapshots");
  const target = path.join(targetParent, "missing-source");
  const entries = [{
    mode: "100644",
    object: "a".repeat(40),
    relative: "missing.mjs"
  }];

  try {
    assert.throws(() => materializeTrackedSnapshot({
      entries,
      expectedDigest: "0".repeat(64),
      overrides: new Map(),
      readBlob: () => {
        throw new Error("missing Git blob");
      },
      targetRoot: target
    }));
    const leftovers = fs.existsSync(targetParent)
      ? fs.readdirSync(targetParent).filter((name) => name.includes(".tmp-"))
      : [];
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("snapshot digest binds tracked mode and commit blob bytes", () => {
  const object = "d".repeat(40);
  const entry = {
    mode: "100644",
    object,
    relative: "scripts/grok-bridge.mjs"
  };
  const readBlob = ({ object: requested }) => {
    assert.equal(requested, object);
    return Buffer.from("bytes-from-pinned-commit\n");
  };

  const digest = digestTrackedTree([entry], readBlob);
  assert.notEqual(
    digest,
    digestTrackedTree([{ ...entry, mode: "100755" }], readBlob)
  );
  assert.notEqual(
    digest,
    digestTrackedTree([entry], () => Buffer.from("mutable-working-tree\n"))
  );
});
