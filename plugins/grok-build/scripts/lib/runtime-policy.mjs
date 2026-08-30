import fs from "node:fs";
import path from "node:path";

const CHILD_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMSPEC",
  "FORCE_COLOR",
  "GROK_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "WT_SESSION"
]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".com", ".exe"]);
const GROK_VALUE_OPTIONS = new Set([
  "agent",
  "agents",
  "allow",
  "cwd",
  "debug-file",
  "deny",
  "disallowedTools",
  "disallowed-tools",
  "effort",
  "json-schema",
  "leader-socket",
  "max-turns",
  "model",
  "output-format",
  "permission-mode",
  "prompt-file",
  "prompt-json",
  "ref",
  "reasoning-effort",
  "resume",
  "rules",
  "sandbox",
  "session-id",
  "single",
  "system-prompt",
  "system-prompt-override",
  "tools",
  "worktree",
  "worktree-ref"
]);
const GROK_MANAGEMENT_COMMANDS = new Set([
  "agent",
  "export",
  "leader",
  "login",
  "logout",
  "mcp",
  "memory",
  "plugin",
  "sessions",
  "setup",
  "trace",
  "update",
  "worktree",
  "wrap"
]);
const GROK_SHORT_VALUE_OPTIONS = new Set(["-m", "-p", "-r", "-s", "-w"]);

function isUsableFile(file, platform) {
  try {
    if (
      platform === "win32" &&
      !WINDOWS_DIRECT_EXTENSIONS.has(path.extname(file).toLowerCase())
    ) {
      return false;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return false;
    }
    if (platform !== "win32") {
      fs.accessSync(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveTrustedExecutable(requested, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const value = String(requested || "").trim();
  if (!value) {
    throw new Error("Executable name is empty.");
  }

  if (value.includes("/") || value.includes("\\")) {
    if (!path.isAbsolute(value)) {
      throw new Error("Executable overrides must use an absolute path: " + value);
    }
    if (!isUsableFile(value, platform)) {
      throw new Error("Executable does not exist or is not runnable: " + value);
    }
    return fs.realpathSync(value);
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = platform === "win32" && path.extname(value) === ""
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter((extension) =>
        WINDOWS_DIRECT_EXTENSIONS.has(extension.toLowerCase())
      )
    : [""];
  for (const entry of String(pathValue).split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) {
      continue;
    }
    const directory = path.resolve(entry);
    if (directory.toLowerCase() === cwd.toLowerCase()) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, value + extension);
      if (isUsableFile(candidate, platform)) {
        return fs.realpathSync(candidate);
      }
    }
  }
  throw new Error(
    "Could not resolve " + value + " from an absolute trusted PATH entry."
  );
}

export function createChildEnvironment(source = process.env, options = {}) {
  const result = {};
  const cwd = path.resolve(options.cwd ?? process.cwd()).toLowerCase();
  for (const [key, value] of Object.entries(source)) {
    if (value != null && CHILD_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      if (key.toUpperCase() === "PATH") {
        result[key] = String(value)
          .split(path.delimiter)
          .filter((entry) =>
            path.isAbsolute(entry) && path.resolve(entry).toLowerCase() !== cwd
          )
          .join(path.delimiter);
      } else {
        result[key] = value;
      }
    }
  }
  if (options.forwardXaiApiKey && source.XAI_API_KEY) {
    result.XAI_API_KEY = source.XAI_API_KEY;
  }
  return result;
}

function optionValues(args, name) {
  const exact = "--" + name;
  const prefix = exact + "=";
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === exact) {
      if (index + 1 >= args.length) {
        throw new Error(exact + " requires a value.");
      }
      values.push(args[index + 1]);
      index += 1;
    } else if (args[index].startsWith(prefix)) {
      values.push(args[index].slice(prefix.length));
    }
  }
  return values;
}

export function singleOptionValue(args, name) {
  const values = optionValues(args, name);
  if (values.length > 1) {
    throw new Error("--" + name + " may be provided at most once.");
  }
  return values[0] ?? null;
}

function setCapabilityOverride(result, key, value, label) {
  if (result[key] != null) {
    throw new Error(label + " may be provided at most once across aliases.");
  }
  if (value == null || value === "") {
    throw new Error(label + " requires a value.");
  }
  result[key] = value;
}

export function extractCapabilityOverrides(inputArgs, options = {}) {
  const result = { model: null, effort: null, args: [] };
  const longOptions = new Map([
    ["--model", ["model", "--model"]],
    ["--effort", ["effort", "--effort"]],
    ...(options.direct
      ? [["--reasoning-effort", ["effort", "--effort"]]]
      : [])
  ]);
  const shortOptions = new Map([
    ["-m", ["model", "--model"]],
    ...(options.direct ? [["-r", ["effort", "--effort"]]] : [])
  ]);

  for (let index = 0; index < inputArgs.length; index += 1) {
    const argument = inputArgs[index];
    let consumed = false;

    for (const [option, [key, label]] of longOptions) {
      if (argument === option) {
        if (index + 1 >= inputArgs.length) {
          throw new Error(option + " requires a value.");
        }
        setCapabilityOverride(result, key, inputArgs[index + 1], label);
        index += 1;
        consumed = true;
        break;
      }
      if (argument.startsWith(option + "=")) {
        setCapabilityOverride(
          result,
          key,
          argument.slice(option.length + 1),
          label
        );
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const [option, [key, label]] of shortOptions) {
      if (argument === option) {
        if (index + 1 >= inputArgs.length) {
          throw new Error(option + " requires a value.");
        }
        setCapabilityOverride(result, key, inputArgs[index + 1], label);
        index += 1;
        consumed = true;
        break;
      }
      if (argument.startsWith(option + "=") || argument.startsWith(option)) {
        const offset = argument.startsWith(option + "=")
          ? option.length + 1
          : option.length;
        setCapabilityOverride(result, key, argument.slice(offset), label);
        consumed = true;
        break;
      }
    }
    if (!consumed) result.args.push(argument);
  }
  return result;
}

export function hasOption(args, name) {
  const exact = "--" + name;
  const prefix = exact + "=";
  return args.some((arg) => arg === exact || arg.startsWith(prefix));
}

function hasWorktreeOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!name.includes("=") && GROK_VALUE_OPTIONS.has(name)) {
        index += 1;
      }
      continue;
    }
    if (/^-[chv]*w/.test(arg)) {
      return true;
    }
    if (/^-[chv]*[mprs]$/.test(arg)) {
      index += 1;
    }
  }
  return false;
}

function firstPositional(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!name.includes("=") && GROK_VALUE_OPTIONS.has(name)) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      if (GROK_SHORT_VALUE_OPTIONS.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return null;
}

function validateSingleValue(values, expected, name, write) {
  for (const value of values) {
    if (value !== expected) {
      const suffix = write
        ? "write mode requires " + expected
        : value + " requires --write";
      throw new Error("--" + name + " " + suffix + ".");
    }
  }
}

export function buildDirectSafetyArgs(args, options = {}) {
  const write = Boolean(options.write);
  const unsafeAlwaysApprove = Boolean(options.unsafeAlwaysApprove);
  const nativeUnsafeOptions = [
    "always-approve",
    "yolo",
    "dangerously-skip-permissions",
    "allow",
    "allowedTools",
    "allowed-tools"
  ];
  if (nativeUnsafeOptions.some((name) => hasOption(args, name))) {
    throw new Error(
      "Pass --unsafe-always-approve to the adapter instead of native " +
      "auto-approval flags or permission allow rules."
    );
  }
  if (GROK_MANAGEMENT_COMMANDS.has(firstPositional(args))) {
    throw new Error(
      "This Grok management subcommand is not supported by direct mode."
    );
  }
  if (unsafeAlwaysApprove && !write) {
    throw new Error("--unsafe-always-approve requires --write.");
  }
  if (hasOption(args, "restore-code")) {
    throw new Error(
      "--restore-code is not supported by this adapter; use Grok directly " +
      "after separately reviewing the checkout impact."
    );
  }
  const cliWriteRequested = hasOption(args, "worktree") ||
    hasWorktreeOption(args) ||
    hasOption(args, "debug-file");
  if (cliWriteRequested) {
    throw new Error(
      "Grok CLI worktree and debug-file options are not supported by this " +
      "adapter; prepare an isolated cwd before invocation."
    );
  }

  const permission = optionValues(args, "permission-mode");
  const sandbox = optionValues(args, "sandbox");
  const expectedPermission = write ? "acceptEdits" : "plan";
  const expectedSandbox = write ? "workspace" : "read-only";
  validateSingleValue(permission, expectedPermission, "permission-mode", write);
  validateSingleValue(sandbox, expectedSandbox, "sandbox", write);

  return [
    ...(permission.length === 0
      ? ["--permission-mode", expectedPermission]
      : []),
    ...(sandbox.length === 0 ? ["--sandbox", expectedSandbox] : []),
    ...(unsafeAlwaysApprove ? ["--always-approve"] : [])
  ];
}

export function assertCleanBridge(dirty, ErrorType = Error) {
  if (String(dirty || "").trim()) {
    throw new ErrorType(
      "Refusing to use a dirty official Grok bridge checkout. " +
      "Restore or reinstall the vendor checkout before continuing."
    );
  }
}

function sourcePath(source) {
  if (typeof source === "string") {
    return source.replace(/\s+\([^)]*\)\s*$/, "");
  }
  return typeof source?.path === "string" ? source.path : null;
}

function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" ||
    (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export function assertSafeProjectPolicy(inspect, options = {}) {
  if (options.unsafeAlwaysApprove) {
    return;
  }
  if (inspect?.projectTrusted !== true) {
    throw new Error(
      "The Grok project is not trusted; safe write mode refuses to continue."
    );
  }
  if (!inspect.projectRoot) {
    throw new Error("Grok inspect did not report a project root.");
  }
  if (!Array.isArray(inspect.permissions?.sources)) {
    throw new Error("Grok inspect did not report permission sources.");
  }
  const parsedSources = inspect.permissions.sources.map(sourcePath);
  if (parsedSources.some((source) => !source)) {
    throw new Error("Grok inspect returned an unknown permission source format.");
  }
  const projectSources = parsedSources
    .filter((source) => isInside(inspect.projectRoot, source));
  if (projectSources.length > 0) {
    throw new Error(
      "Safe write mode refuses project-level permission rules. " +
      "Remove them or use the separately authorized " +
      "--unsafe-always-approve mode."
    );
  }
}

export function shouldInstallStable(check) {
  return check?.updateAvailable === true || check?.channel !== "stable";
}

export function isVerifiedStableCli(record, version) {
  return record?.channel === "stable" &&
    typeof record.version === "string" &&
    record.version === version;
}

export function resolveCommandCapabilities(options) {
  if (options.noSync) {
    return options.probe(options.overrides);
  }
  return options.sync(options.overrides).capabilities;
}
