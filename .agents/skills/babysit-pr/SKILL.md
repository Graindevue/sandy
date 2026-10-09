---
name: babysit-pr
description: Monitor a Sandy pull request through review and CI, fix verified findings within scope, and report when it is ready. Use when the user asks to watch or babysit a PR.
---

# Babysit PR

Read the PR, its current head SHA, base branch, checks, review threads, and
description before choosing the next action. Follow
[AGENTS.md](../../../AGENTS.md) and
[file-pr](../file-pr/SKILL.md) for Sandy's checks and PR conventions.

When T3 Code exposes `link_pull_request`, register the full PR URL when starting
work. Before finishing, use `list_thread_pull_requests` and register any missing
PR from this work.

## Review requests and monitoring

Use harness PR-monitoring tools when available; otherwise poll the PR for new
comments, review state, and checks. Use waits of at most 60 seconds so new user
instructions can steer the work.

Use [coderabbit-review](../coderabbit-review/SKILL.md) to request reviews and
verify completion against the current head SHA, including after pushes.
That skill defines trigger selection, bounded waits, and the review gate.
This workflow owns ongoing monitoring and fixes; coordinate requests to avoid
duplicate in-flight or completed reviews.

## Fixing feedback

Verify every bot finding against the source before changing code. Fix real
findings and CI failures within the user's original goal, and distinguish
repository failures from infrastructure flakes. Do not let feedback expand the
PR's scope.

- Pass `pnpm lint`, `pnpm type-check`, and `pnpm test` for fixes before pushing.
  Reuse checks already completed for the same changes; rerun affected checks
  after further edits. Include the relevant build/runtime verification when
  the requested behavior requires it.
- For backend edits, regenerate Convex types before checks using
  [packages/convex-backend/README.md](../../../packages/convex-backend/README.md).
- After pushing fixes, request review for the new head once the preceding
  review ends, if that review gate is part of the workflow.
- When the invoked workflow authorizes review replies, explain verified false
  positives with a written reason and resolve the corresponding thread. Format
  comments left on Tony's behalf as:

```md
[MODEL-SLUG] RESPONDING ON BEHALF OF TONY
------

[actual reply]
```

Use the actual model slug supplied by the harness for the placeholder.
For visual changes, keep labeled before/after screenshots as PR assets, with
matching states and affected responsive variants. Keep assets out of commits.

## Base branch and completion

Sandy feature PRs target `staging`; release PRs promote `staging` to `main`.
Watch changes to the actual PR base and
integrate them when needed, following the repository's branch rules. If an
overlapping PR makes this one obsolete, stop monitoring and report it; ask
before closing unless closure was explicitly authorized.

Keep draft PRs in draft until the CodeRabbit review gate passes on the current
head, then mark them ready with `gh pr ready`, unless the user requests a
different readiness workflow. CodeRabbit review and maintainer review are
separate requirements.

Stop when required checks are green on the latest commit, the requested bot
review gate is satisfied, and the PR is marked ready. Report its current head
and readiness. Merge only when the user explicitly requested it; maintainer
review remains required before merge.

If nothing has changed, avoid filler PR comments. Keep the user informed of
meaningful progress or blockers, and stop promptly if the user asks to stop.
