# @narumitw/pi-subagents

Run named Pi agents in visible terminal-multiplexer sessions or headless child processes. Interactive and async are separate choices: an agent can run in a real Zellij pane while the parent keeps working.

This AmpliFlow fork uses the runtime from [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents) and keeps the monorepo package identity.

## Requirements

- Pi 0.85 or later.
- Zellij, tmux, WezTerm, cmux, or Herdr for interactive agents.
- A named agent definition. This package includes `general`, `scout`, `worker`, and `reviewer` defaults.

Interactive launches fail with a setup message when Pi is not running in a supported multiplexer. They do not silently switch to headless execution.

## Tools

The extension registers:

- `subagent`: start one or more named agents.
- `subagent_resume`: resume a saved child session.
- `subagent_kill`: stop a running child.

Use `/subagents` or `Alt+S` to inspect, focus, resume, or stop agents.

## Quick start

Ask Pi to delegate to a bundled agent:

```text
Use the scout agent to find where authentication errors are mapped.
```

A direct tool call can choose blocking or asynchronous delivery:

```json
{
  "name": "auth-scout",
  "agent": "scout",
  "task": "Find authentication error mapping and return exact paths.",
  "async": true
}
```

The bundled agents default to visible, asynchronous, auto-exiting sessions. The parent remains usable while they run. A child stays open when the operator interacts with it.

## Agent definitions

Add or override agents with Markdown files in:

- `~/.pi/agent/agents/*.md`
- `<project>/.pi/agents/*.md`

Project definitions override global definitions, and global definitions override the package defaults.

Example:

```markdown
---
name: test-runner
description: Run focused tests and explain failures.
mode: interactive
async: true
auto-exit: true
tools: read,grep,find,ls,bash
spawning: false
session-mode: standalone
parent-close-policy: terminate
---
Run the narrowest relevant tests. Do not edit files.
```

Important fields:

- `mode`: `interactive` or `background`.
- `async`: return control to the parent immediately when `true`.
- `auto-exit`: close after one completed turn unless a person interacted with the child.
- `tools`, `skills`, `extensions`: child capability policy.
- `model`, `thinking`: fixed child model settings. Omit them to inherit from the parent.
- `session-mode`: `standalone`, `lineage-only`, or `fork`.
- `timeout`, `idle-timeout`: execution budgets in seconds.
- `parent-close-policy`: `terminate` or `continue`.
- `spawning`: whether the child can launch more agents.

See the source agent parser in `src/agents/definitions.ts` for the complete field set.

## Multiplexer placement

Set `PI_SUBAGENT_ZELLIJ_PLACEMENT` when using Zellij:

- `auto`
- `right-stack`
- `down-stack`
- `floating`
- `tab-stack`

The runtime tracks the pane or tab it owns. Cancellation and parent shutdown close that surface rather than relying on process-name matching.

## Checklist integration

`af-checklist-watch` uses the private event documented in [docs/af-checklist-watch-event.md](docs/af-checklist-watch-event.md). The event always launches a visible asynchronous worker with a fixed profile. It is not a generic job API.

## Installation

The package loads TypeScript directly from `src/index.ts`:

```json
{
  "packages": [
    "git:github.com/AmpliFlow/pi-extensions"
  ]
}
```

The AmpliFlow managed configuration filters that package to `packages/pi-subagents/src/index.ts`.

## Development

From the monorepo root:

```bash
npm test
npm run check:boundaries
npm pack --workspace @narumitw/pi-subagents --dry-run --json
```

From this package:

```bash
npm run typecheck
npm run check
```

Run live interactive checks from a fresh Pi session inside Zellij.

## License

MIT. The license keeps the narumiruna, HazAT, and edxeth notices for the combined work.
