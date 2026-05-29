# `.sandcastle` — AFK coding-agent harness

This directory runs Sandy's own backlog through a long-running, multi-agent loop
built on [`@ai-hero/sandcastle`](https://www.npmjs.com/package/@ai-hero/sandcastle)
and Apple Container sandboxes. It is the same harness used in the `graindevue`
project, adapted to Sandy's stack and conventions.

> This is for developing **Sandy itself** with coding agents. It is separate from
> Sandy's product (which reviews other repos' PRs), even though both lean on
> sandcastle and Apple Container. See `CONTEXT.md` and `docs/adr/`.

## What it does

Each outer iteration:

1. **Plan** (`plan-prompt.md`) — an agent reads open issues labeled
   `ready-for-agent`, builds a dependency graph, and emits a `<plan>` of
   unblocked issues with branch names (`sandcastle/issue-<id>-<slug>`).
2. **Execute**, in parallel per issue, each in its own sandbox:
   - **implement** (`implement-prompt.md`) — TDD the fix, commit (Conventional
     Commits), run `pnpm type-check` / `pnpm test` / `pnpm lint`.
   - **review** (`review-prompt.md`) — local clarity/correctness pass.
   - **publish** (`publish-pr-prompt.md`) — open a draft PR targeting `staging`
     with `Closes #<id>`.
   - **review gate** (`review-gate-prompt.md`) — drive **CodeRabbit** to a clean
     state (Sandy's automated reviewer per `AGENTS.md`).

The pipeline stops at "ready for human review" — it never merges.

## Files

| File | Purpose |
| ---- | ------- |
| `main.mts` | Orchestrator loop. Imports the provider from `@sandy/apple-container-provider`. |
| `plan-prompt.md` | Phase 1 planner prompt. |
| `implement-prompt.md` / `review-prompt.md` / `publish-pr-prompt.md` / `review-gate-prompt.md` | Phase 2 agent prompts. |
| `CODING_STANDARDS.md` / `OPENSRC.md` | Standards + dependency-source lookup, referenced by the prompts. |
| `.env.example` | Secrets the orchestrator needs (copy to `.env`). |
| `Dockerfile` | Dev-harness agent image (codex + cursor CLIs); built by `pnpm sandcastle:build-agent-image`. |

The Apple Container provider code is **not** duplicated here — it lives in
`packages/apple-container-provider` (ADR 0009), the single source of truth. The
harness's own agent image is `.sandcastle/Dockerfile` (it ships the codex +
cursor CLIs the agents invoke), distinct from sandy's Claude-based product image
at `images/agent/Dockerfile`.

## Prerequisites

```bash
# 1. Install + build the workspace so the provider's dist exists.
pnpm install
pnpm -r build

# 2. Build the harness agent image (tag: sandcastle:sandy).
pnpm sandcastle:build-agent-image

# 3. Secrets: copy and fill in.
cp .sandcastle/.env.example .sandcastle/.env   # set CURSOR_API_KEY (+ GH_TOKEN if gh isn't logged in)

# 4. Host logins the sandbox mounts read-only:
#    - `gh auth login`         (GitHub)
#    - `codex login`           (~/.codex, for the codex agents)
#    - opensrc installed       (~/.opensrc)
```

Wiring `pnpm sandcastle` requires these dev dependencies at the repo root:
`tsx`, `@ai-hero/sandcastle`, and `@sandy/apple-container-provider` (workspace).

## Run

```bash
git switch staging      # never run from main
pnpm sandcastle         # == npx tsx .sandcastle/main.mts
```

## Notes

- **Branching**: targets `staging` only, never `main` (`AGENTS.md`). The script
  refuses to run from `main`.
- **Adapted from graindevue**: provider extracted to a package; Greptile gate
  replaced with CodeRabbit; turbo build replaced with `pnpm -r`; commit style is
  Conventional Commits with no AI footers.
- `worktrees/`, `pnpm-store/`, `logs/`, and `.env` are gitignored.
