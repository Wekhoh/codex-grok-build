import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelative(value) {
  const relative = String(value).replaceAll("\\", "/");
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").includes("..")
  ) {
    throw new Error("Tracked bridge path is unsafe: " + value);
  }
  return relative;
}

export function parseTrackedTree(output, gitRoot) {
  const normalizedRoot = String(gitRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  const prefix = normalizedRoot + "/";
  const entries = [];
  const seen = new Set();

  for (const record of String(output).split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator === -1) {
      throw new Error("Git returned an invalid tracked bridge entry.");
    }
    const metadata = record.slice(0, separator).match(
      /^(\d{6})\s+(\S+)\s+([0-9a-f]+)$/i
    );
    if (!metadata) {
      throw new Error("Git returned invalid tracked bridge metadata.");
    }
    const [, mode, type, object] = metadata;
    const gitPath = record.slice(separator + 1).replaceAll("\\", "/");
    if (!gitPath.startsWith(prefix)) {
      throw new Error("Tracked bridge entry escaped the requested root: " + gitPath);
    }
    if (type !== "blob") {
      throw new Error("Tracked bridge entry is not a file: " + gitPath);
    }
    if (mode === "120000") {
      throw new Error("Tracked bridge symbolic links are not supported: " + gitPath);
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("Tracked bridge file mode is unsupported: " + mode);
    }
    const relative = normalizedRelative(gitPath.slice(prefix.length));
    if (seen.has(relative)) {
      throw new Error("Tracked bridge entry is duplicated: " + relative);
    }
    seen.add(relative);
    entries.push({ mode, object, relative });
  }

  if (entries.length === 0) {
    throw new Error("The pinned commit contains no tracked bridge files.");
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

function regularFileContent(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Bridge snapshot source is not a regular file: " + target);
  }
  return fs.readFileSync(target);
}

function filesystemEntries(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Bridge snapshot may not contain symbolic links: " + absolute);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        entries.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      } else {
        throw new Error("Bridge snapshot contains an unsupported entry: " + absolute);
      }
    }
  };
  visit(root);
  return entries.sort();
}

export function digestTrackedTree(entries, readBlob, overrides = new Map()) {
  const lines = entries.map((entry) => {
    const content = overrides.has(entry.relative)
      ? overrides.get(entry.relative)
      : readBlob(entry);
    return entry.relative + "\0" + entry.mode + "\0" + sha256(content);
  });
  return sha256(lines.join("\n"));
}

function verifySnapshot(root, entries, expectedDigest) {
  const expectedEntries = entries.map((entry) => entry.relative);
  const actualEntries = filesystemEntries(root);
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error("Bridge snapshot does not match the pinned tracked tree.");
  }
  const actualDigest = digestTrackedTree(
    entries,
    (entry) => regularFileContent(root, entry.relative)
  );
  if (actualDigest !== expectedDigest) {
    throw new Error("Bridge snapshot does not match the expected digest.");
  }
  return actualDigest;
}

export function materializeTrackedSnapshot({
  entries,
  expectedDigest,
  overrides = new Map(),
  readBlob,
  targetRoot
}) {
  if (fs.existsSync(targetRoot)) {
    return verifySnapshot(targetRoot, entries, expectedDigest);
  }

  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  const staging = targetRoot + ".tmp-" + process.pid + "-" + randomUUID();
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const entry of entries) {
      const destination = path.join(staging, ...entry.relative.split("/"));
      const content = overrides.has(entry.relative)
        ? overrides.get(entry.relative)
        : readBlob(entry);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, {
        mode: entry.mode === "100755" ? 0o755 : 0o644
      });
    }
    verifySnapshot(staging, entries, expectedDigest);
    try {
      fs.renameSync(staging, targetRoot);
    } catch (error) {
      if (!fs.existsSync(targetRoot)) throw error;
    }
  } finally {
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return verifySnapshot(targetRoot, entries, expectedDigest);
}
