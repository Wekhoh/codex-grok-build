# Codex Grok Build

Use xAI Grok Build from Codex as an independent coding collaborator for
consultation, adversarial review, debate, verification, implementation
delegation, parallel research, and Grok-managed subagents.

This project is a Codex-native adapter around the real Grok CLI and xAI's
official Grok Build bridge. It does not emulate Grok, proxy through an
unofficial API, or redistribute the official bridge.

## Why this exists

xAI publishes an official Grok Build plugin for Claude Code. Codex Grok Build
keeps that official bridge as the execution foundation and adds:

- Codex plugin packaging and skill discovery
- Stable-channel CLI updates and verified official-bridge synchronization
- Dynamic selection of the highest available stable flagship model
- Model-specific reasoning discovery from the installed Grok CLI catalog
- Grok 4.6 `xhigh` support through a verified local bridge overlay
- Direct Grok CLI access for native subagent workflows
- Collaboration patterns for debate, verification, and parallel review
- Output-quality gates: process completion is not treated as answer acceptance

## Requirements

- Codex with plugin support
- Node.js 18.18 or newer
- Git
- The official Grok CLI available as grok on PATH
- A logged-in Grok CLI session; grok models must succeed

Follow xAI's official Grok Build documentation to install and authenticate the
Grok CLI: https://github.com/xai-org/grok-build-plugin-cc

## Install

Add this repository as a Codex marketplace:

~~~powershell
codex plugin marketplace add Wekhoh/codex-grok-build
~~~

Install the plugin:

~~~powershell
codex plugin add grok-build@codex-grok-build
~~~

Start a new Codex conversation after installation so the bundled skill is
discovered.

To update later:

~~~powershell
codex plugin marketplace upgrade codex-grok-build
codex plugin add grok-build@codex-grok-build
~~~

Start a new conversation after reinstalling so Codex loads the updated skill.

## Use

Ask Codex naturally:

- Ask Grok to independently review this change and verify every finding.
- Have Codex and Grok debate this architecture before choosing a design.
- Let Grok implement the bounded change, then have Codex inspect the diff and
  run the tests.
- Ask one Grok leader to start three read-only subagents for architecture,
  correctness, and security.
- Run two independent Grok investigations concurrently and reconcile the
  disagreement.

The installed skill resolves the adapter from its own plugin directory. No
developer-specific absolute paths are required.

## Adapter commands

The adapter lives at plugins/grok-build/scripts/grok-codex.mjs.

~~~text
sync
capabilities
check
run
review
critique
runs
show
stop
import
direct
~~~

The adapter normally synchronizes before work. Pass --no-sync when a workflow
already synchronized once. It chooses the highest numeric model reported by
`grok models` and that model's highest advertised reasoning effort. With Grok
CLI 1.0.13, for example, Grok 4.6 exposes `xhigh`, `high`, `medium`, and `low`,
while Grok 4.5 exposes `high`, `medium`, and `low`. Set `GROK_MODEL` or
`GROK_REASONING_EFFORT` only when an explicit override is required.

The adapter runs proxy commands from a content-addressed snapshot containing
only files tracked by the pinned official bridge commit. When the selected
effort is valid for the model but absent from the bridge whitelist, it patches
only the snapshot copy. It verifies the complete snapshot against the official
tracked tree plus the expected patch before running it; ignored local files
cannot enter the runtime, and the vendor checkout remains untouched. If the
CLI catalog is missing or does not match the running CLI version, the adapter
falls back to the official bridge's advertised levels and prints a warning
rather than guessing.

The import command is a low-level pass-through to xAI's Claude-oriented bridge.
It does not automatically discover or import the current Codex transcript; pass
an explicit source supported by the upstream grok import command.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| GROK_BINARY | Override the Grok executable with an absolute path |
| GROK_BUILD_REPOSITORY | Override the local official-bridge checkout path |
| GROK_BUILD_PLUGIN_DATA | Override the writable run-state directory |
| GROK_BUILD_COMMAND_TIMEOUT_MS | Bound update and capability probes (default 120000) |
| GROK_BUILD_FORWARD_XAI_API_KEY | Set to 1 only when API-key auth must be forwarded |
| GROK_HOME | Override the Grok CLI configuration and model-catalog directory |
| GROK_MODEL_CACHE_FILE | Override the model catalog with an absolute file path |
| GROK_MODEL | Pin an available model |
| GROK_REASONING_EFFORT | Pin a reasoning level supported by the selected model |

## Safety model

- Read-only work uses plan permission mode and a read-only sandbox by default.
- Write delegation must use `direct --write`; it is workspace-sandboxed and
  does not auto-approve every tool. The separate `--unsafe-always-approve`
  switch is available only with `--write`.
- Safe write mode requires a trusted Grok project and refuses project-level
  permission rules that could silently auto-approve tools.
- Child processes receive a minimal environment. `XAI_API_KEY` is forwarded
  only with the explicit environment opt-in above; normal logged-in sessions
  do not need it.
- Concurrent writers must use separate Git worktrees.
- Official bridge updates must come from the expected xAI origin, stay on main,
  remain clean and traceable to `origin/main`, and fast-forward cleanly.
- Runtime snapshots and compatibility overlays contain only pinned tracked
  files, are content-addressed and verified, and never alter or masquerade as
  the official bridge checkout.
- Codex remains responsible for verifying material claims, diffs, and tests.
- Multiple model answers are correlated samples, not independent proof.

## Known limitations

- The upstream bridge currently has Windows-specific test and shell warnings.
- Simultaneous background enqueue operations in one workspace can contend on
  the bridge state lock; enqueue quickly one at a time, then let jobs run in
  parallel.
- A terminal completed status does not guarantee a complete answer.
- High parent-session concurrency may cause cancellations or quota pressure.
- Automatic upstream updates can expose compatibility changes; the adapter
  deliberately follows xAI's `main` branch for timely updates, validates the
  checkout before every execution, but cannot guarantee future APIs.

## Development

~~~powershell
npm test
~~~

Validate the plugin with Codex's plugin creator when available:

~~~powershell
$env:PYTHONUTF8=1
python path\to\plugin-creator\scripts\validate_plugin.py plugins\grok-build
~~~

## Architecture

~~~text
Codex
  -> Codex Grok Build skill and adapter
     -> xAI official Grok Build bridge
        -> official Grok CLI
           -> Grok
~~~

The official bridge is cloned to the user's Codex vendor directory on first
sync. Runtime state is stored separately under the user's Codex plugin-data
directory.

## License and attribution

Apache-2.0. See LICENSE and NOTICE.

This is an independent community project and is not affiliated with xAI or
OpenAI. Grok and xAI are trademarks of xAI. Codex and OpenAI are trademarks of
OpenAI.
