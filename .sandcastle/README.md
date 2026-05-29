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
3. **Merge** (`merge-prompt.md`) — one agent merges every completed branch into
   `staging`, one at a time, keeping it green (`pnpm type-check` / `pnpm test`)
   and skipping any branch it can't merge cleanly. It runs with the
   `merge-to-head` branch strategy (isolated worktree, fast-forwarded back into
   the host `staging`). The orchestrator then pushes `staging` to `origin` and
   closes the merged issues.

There are no per-issue PRs and no external automated reviewer. Work is merged
autonomously into `staging`; a human reviews the accumulated `staging` diff and
promotes `staging`→`main` via a separate release PR (`AGENTS.md`).

## Files

| File | Purpose |
| ---- | ------- |
| `main.mts` | Orchestrator loop. Imports the provider from `@sandy/apple-container-provider`. |
| `plan-prompt.md` | Phase 1 planner prompt. |
| `implement-prompt.md` / `review-prompt.md` | Phase 2 per-issue agent prompts. |
| `merge-prompt.md` | Phase 3 merge prompt (merge completed branches into `staging`). |
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
- **Adapted from graindevue**: provider extracted to a package; the external
  review gate (Greptile/CodeRabbit) dropped in favor of autonomous merge to
  `staging`; turbo build replaced with `pnpm -r`; commit style is Conventional
  Commits with no AI footers.
- `worktrees/`, `pnpm-store/`, `logs/`, and `.env` are gitignored.
