---
name: grok-build
description: Use xAI Grok Build from Codex for independent consultation, adversarial review, debate, verification, implementation delegation, parallel research, meetings, or Grok-managed subagents. Use when the user explicitly mentions Grok or Grok Build, asks Codex and Grok to collaborate, or when a complex, uncertain, high-impact, architecture, debugging, security, or review task would materially benefit from an independent second model. Also use proactively for important deliverables when cross-model challenge can improve quality; skip routine low-risk work where another model would add little value.
---

# Grok Build collaboration

Use Codex as the orchestrator and final decision maker. Use Grok as an
independent collaborator, not as proof by authority.

## Resolve the adapter

Never assume the plugin developer's home directory.

Locate this installed SKILL.md from the path exposed by the current skill
registry. Its plugin root is three directories above this file:

~~~text
<plugin-root>/skills/grok-build/SKILL.md
<plugin-root>/scripts/grok-codex.mjs
~~~

Resolve the adapter to an absolute path once per workflow. On PowerShell, after
placing the actual path to this SKILL.md in the first variable:

~~~powershell
$skillFile = '<absolute path to this SKILL.md>'
$pluginRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $skillFile))
$adapter = Join-Path $pluginRoot 'scripts\grok-codex.mjs'
~~~

Use node with the resolved adapter path in every command below.

## Prepare once per workflow

~~~powershell
node $adapter sync --json
node $adapter capabilities --no-sync --json
~~~

Run sync once before the first Grok call in a user workflow. It checks and
installs a newer stable Grok CLI, fast-forwards the xAI official bridge
checkout, refreshes available models, and discovers each model's reasoning
levels from the version-matched Grok CLI catalog.

Continue with verified local versions if only a network update check fails.
Stop and report the exact error if Grok is absent, unauthenticated, or the local
runtime is invalid. A dirty, detached, divergent, or unexpected bridge checkout
is invalid and must fail closed.

Do not hardcode a model or effort in normal calls. The adapter chooses the
highest numeric stable flagship returned by grok models and the highest effort
advertised for that selected model. If the official bridge has not yet added a
valid model effort such as Grok 4.6 `xhigh`, the adapter uses a verified local
compatibility overlay without modifying the official checkout. Explicit user
overrides still win, and unsupported model/effort combinations fail closed.
Report the actual CLI version, bridge commit, model, and effort in the handoff.

## Choose a collaboration pattern

- Consult: run one fresh read-only Grok session for an independent solution.
- Verify: run two fresh read-only sessions with distinct evidence duties, then
  have Codex verify their claims against primary artifacts.
- Adversarial review: ask one Grok session to find concrete defects and another
  to challenge those findings. Accept only evidence-supported findings.
- Debate or meeting: start two to four fresh sessions with distinct roles.
  Share a neutral brief in round one, cross-review positions in round two, then
  synthesize agreement, disagreement, and the owner decision.
- Delegate: allow one Grok session to implement a bounded task. Use write
  permission only for implementation, inspect the diff, and run tests.
- Grok subagents: use direct mode and require the Grok leader to call
  spawn_subagent for two to four distinct read-only roles.
- Parallel research: use official bridge background jobs and collect every
  result before synthesis.

## Invoke the adapter

Read-only foreground consultation:

~~~powershell
node $adapter run --no-sync --fresh --cwd $repo 'Inspect the repository and return an evidence-grounded answer. Do not modify files.'
~~~

Background calls for concurrency. Launch bridge jobs one command at a time
without waiting for results. Once each command returns a run ID, the jobs run
concurrently. Do not issue enqueue commands at the exact same instant because
the official bridge uses a workspace-level state lock.

~~~powershell
node $adapter run --no-sync --background --fresh --cwd $repo 'Act as the skeptical reviewer. Return only material risks with evidence.'
node $adapter runs '<run-id>' --cwd $repo --wait --timeout-ms 600000 --json
node $adapter show '<run-id>' --cwd $repo --json
~~~

Native review and focused critique:

~~~powershell
node $adapter review --no-sync --wait --cwd $repo --scope working-tree
node $adapter critique --no-sync --wait --cwd $repo --scope working-tree 'Challenge correctness, security, regressions, and missing tests.'
~~~

Bounded implementation uses direct mode so the adapter can enforce the
workspace sandbox. It does not auto-approve every tool call:

~~~powershell
node $adapter direct --no-sync --write --cwd $repo -p 'Implement only the specified bounded change. Run relevant tests and summarize the diff.'
~~~

Only when the user separately authorizes unattended tool approval may you add
`--unsafe-always-approve`. `run --write` is intentionally rejected because the
official bridge currently turns it into unrestricted automatic approval. Safe
write mode also refuses untrusted projects and project-level permission rules;
do not bypass that check without the same separate authorization.

Grok leader with three real read-only subagents:

~~~powershell
node $adapter direct --no-sync --cwd $repo --max-turns 24 -p 'Actually call spawn_subagent three times with background=true, subagent_type=explore, and capability_mode=read-only for architecture, correctness, and security. Start all three before waiting. Return every real subagent id, evidence, conflicts, and a reconciled conclusion. Do not fabricate ids or modify files.'
~~~

For concurrent write tasks, never point multiple agents at the same checkout.
Give each a separate Git worktree, then let one owner inspect and merge.
Read-only calls may share a checkout.

## Prompt and synthesis quality

- Give every participant the same neutral objective, scope, artifact paths,
  constraints, and output contract.
- Assign genuinely different roles or evidence sets. Identical calls are
  correlated samples, not independent proof.
- Prefer fresh sessions for independent judgment. Resume only for continuity.
- Ask for file paths, symbols, commands, logs, citations, and uncertainty.
- Preserve run IDs for auditability. Stop orphaned jobs with stop <run-id>.
- Treat completed as process completion, not answer acceptance. Require the
  requested sections and usable evidence. Retry or resume an incomplete result
  once; do not include it in consensus.
- Limit expensive direct calls to two concurrent parent sessions by default. A
  single Grok leader may instead fan out to two to four read-only subagents.
- Let Codex independently inspect material findings before acting.
- Never claim a model or effort upgrade from configuration alone; use
  capabilities --json as runtime evidence.

User authorization for Grok does not expand repository scope, external-system
scope, or destructive-operation authority.
