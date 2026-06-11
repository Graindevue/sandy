# Sandy PRDs

Each phase below is an independently-shippable milestone. PRDs describe scope, deliverables, acceptance criteria, and dependencies. They are designed to be fed into the `to-issues` workflow to generate independently-grabbable GitHub issues.

## Phases

| # | PRD | One-line goal |
|---|-----|---------------|
| 1 | [Phase 1 — First Useful Review](./phase-01-first-useful-review.md) | One Agent, one Product, one Repo, end-to-end webhook → review → comment. |
| 2 | [Phase 2 — Parallel Specialized Agents](./phase-02-parallel-agents.md) | Multi-Agent fan-out, API Surface Manifest, per-Repo `.bot/`, confidence score, 2nd-Repo ready. |
| 3 | [Phase 3 — Learning Loop Active](./phase-03-learning-loop.md) | Embedding clustering, reactions → Archetypes → SuggestedRules → manual promotion. |
| 4 | [Phase 4 — Polish](./phase-04-polish.md) | "Fix in CC" prompts, `@bot` command vocabulary, ops improvements, CLI if needed. |

## Phase dependency graph

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
                          ▲
                          └── Reaction & merge-state signals piggyback
                              on the comment infrastructure from Phase 1
                              (HTML trailer is load-bearing from day 1).
```

Phases are strictly sequential. Phase N+1 assumes Phase N is merged and stable on the host.

## Feature PRDs

Standalone features that aren't tied to a phase:

| PRD | One-line goal |
|-----|---------------|
| [Run tests inside reviews](./feature-run-tests-in-reviews.md) | Install deps + run the target Repo's test suite in the review sandbox so coverage/Convex findings are verified, not guessed. |

## Working with these PRDs

The intended workflow:

1. Read the PRD in full to understand scope and acceptance criteria.
2. Use `/to-issues` (or the project's issue-breakdown skill) to convert one PRD into a set of independently-grabbable GitHub issues, each implementing one logical unit (a package, a module, a config file, an end-to-end test).
3. Issues are picked off one at a time. Sandy reviews its own PRs once Phase 1 lands.
4. Phase is complete when all its acceptance criteria are checked and a clean end-to-end test passes.

## What's NOT a PRD

- ADRs — capture architectural *decisions*. See [`../adr/`](../adr/).
- CONTEXT.md — captures the domain vocabulary. See [`../../CONTEXT.md`](../../CONTEXT.md).
- README / CONTRIBUTING — capture project orientation. See the repo root.

If a piece of work spans more than one phase or has a cross-cutting architectural angle, write an ADR first, then update the affected PRDs to reference it.

## Status convention

Each PRD starts as `Status: Draft`. It moves to `In Progress` when its first issue is picked up, `Complete` when all acceptance criteria are checked. Statuses should be updated in the PRD header as work progresses.

## Re-scoping

Phase 4 is intentionally underspecified and will be re-scoped based on real usage signal from Phases 1-3. Other phases may also be re-scoped if real implementation surfaces unanticipated work; in that case, amend the PRD via a normal PR rather than letting code drift away from the spec silently.
