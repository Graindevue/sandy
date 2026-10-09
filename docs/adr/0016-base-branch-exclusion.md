# 16. Base-Branch Exclusion is a per-Repo denylist that only gates automatic arming

Date: 2026-06-04

Status: Superseded by [0017](0017-manual-only-review-triggering.md)

> **Superseded.** This ADR gated the *automatic* `gh pr ready` arming trigger.
> ADR 0017 makes reviews manual-only, so there is no automatic trigger left to
> gate and Base-Branch Exclusion is retired. The `excludeBranches` config key is
> now inert (kept for compatibility), and the matcher module plus its dispatch
> wiring have been removed. The record below is kept for history.

## Context

Sandy's Sticky Opt-In trigger model was branch-agnostic. A PR targeting a
generated, vendored, release-train, or sandbox branch would be auto-armed by the
same `ready_for_review` event as any other PR. Operators could avoid that only by
removing the Repo from `.config/bot.yaml`, which also disabled Sandy for every
normal branch in that Repo.

The branch being decided is the PR base branch (target), already parsed from
GitHub webhook payloads as `baseRef`.

## Decision

Add a per-Repo `excludeBranches` field to `.config/bot.yaml`. It is an optional
denylist of glob patterns matched against `baseRef`; omitted or empty means no
branches are excluded.

The exclusion gates only automatic Review arming from `ready_for_review`
(`gh pr ready`). An explicit `@bot review` mention always overrides the
exclusion, flips `reviewActive`, and subsequent pushes retrigger Reviews through
normal Sticky Opt-In behavior. Pushes to excluded-branch PRs that were never
manually armed remain no-ops because `reviewActive` is false.

The matcher is a small pure function over `(baseRef, patterns)` using Node's
built-in `matchesGlob`. The dispatcher resolves patterns from config, computes a
skip reason, and passes that verdict into the trigger evaluator so the evaluator
stays free of config and glob knowledge. A skipped automatic trigger returns a
distinct dispatch outcome and logs the repo, PR number, and base branch, but
posts no PR comment.

## Consequences

- Existing configs keep their behavior because the field defaults to an empty
  denylist.
- Exclusions are owned by the operator per Repo; a branch exclusion for one Repo
  does not affect sibling Repos in the same Product.
- A deliberate human request remains available even on excluded branches.
- Retargeting an already-armed PR onto an excluded branch does not retroactively
  clear `reviewActive`; base-change events remain out of scope for now.
