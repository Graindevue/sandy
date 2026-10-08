# 3. @ai-hero/sandcastle as agent runtime, used upstream without forking

Date: 2026-05-28

Status: Superseded by [0018](./0018-github-actions-codex-runtime.md)

> **Historical decision.** ADR 0018 replaces Sandcastle and Apple Container with GitHub Actions and Codex CLI. The original runtime rationale below is preserved for history.

## Context

Sandy needs an agent runtime that:

- Spawns coding Agents in sandboxed environments
- Supports multiple LLM vendors (Claude, OpenAI/Codex, Cursor) so different Agents can use different models
- Manages container lifecycle (build, mount, exec, cleanup) on macOS via Apple Container
- Handles per-Agent prompts + completion signals + max-iteration limits

Three options were evaluated:

- **A)** Claude Agent SDK directly. Clean, official, well-supported — but only Claude.
- **B)** Hand-rolled tool-use loop on top of raw vendor SDKs. Maximum control, maximum maintenance cost.
- **C)** [`@ai-hero/sandcastle`](https://www.npmjs.com/package/@ai-hero/sandcastle), an existing package designed for AFK long-running coding agents.

## Decision

Sandy uses `@ai-hero/sandcastle` as its agent runtime. The package is consumed as a direct npm dependency. It is not forked.

Sandcastle provides:

- Multi-vendor providers (claude / codex / cursor / copilot via CLI subprocesses parsed as `--output-format=stream-json`)
- Apple Container lifecycle management (`apple-container.ts`) including signal-handler cleanup
- Per-run worktree mounting with curated host-mount allowlists
- Prompt-per-role + completion-signal terminators
- `Promise.allSettled` per-branch fault isolation

Sandy builds these on top of Sandcastle:

- Webhook receiver (Sandcastle has none)
- Within-Review parallel agent fan-out (Sandcastle parallelizes branches; Sandy needs to parallelize Agents within one branch)
- Findings Synthesizer
- GitHub posting
- Multi-Product / multi-Repo registration

## Consequences

- **Container security model is Sandcastle's.** Agents run with full permissions inside their Apple Container (Sandcastle sets `dangerouslySkipPermissions: true`). The container is the security boundary. Sandy does not constrain Agent tool access; instead, mounts are tightly scoped.
- **Vendor set is frozen** at Sandcastle's supported list (claude, codex, cursor, copilot). Adding a new vendor (e.g., Gemini) requires upstreaming to Sandcastle or eventually forking.
- **No CLI-parsing brittleness in Sandy itself.** Sandcastle parses stream-json from vendor CLIs; Sandy receives the parsed output.
- **macOS-only.** Apple Container does not run on Linux/Windows. Sandy deployment is therefore mac-only (M1+ Apple Silicon required). This rules out Raspberry Pi as a deployment target.
- **Sandcastle's API surface changes affect Sandy.** Direct dependency means Sandy adapts to upstream evolution. Acceptable while Sandcastle is actively maintained.

## When to revisit

Reconsider forking if (a) Sandcastle goes unmaintained, (b) Sandy needs a first-class feature that conflicts with Sandcastle's design (e.g., read-only mode, structured output beyond completion signals as a primary API, non-Apple-Container backends), or (c) the vendor frozen list becomes a hard blocker.
