# @sandy/convex-backend

Convex schema and functions for Sandy's queue and review state, deployed to
Convex Cloud (ADR 0004).

## Tables

`products`, `repos`, `pullRequests`, `reviewJobs`, `findings`, `archetypes`,
`reactions`, `suggestedRules`, `agentRuns`, `apiSurfaceManifests` — see
[`convex/schema.ts`](./convex/schema.ts). Convex adds `_id` and `_creationTime`
to every row.

## Functions

- **reviewJobs** — `enqueue`, `enqueueSuperseding` (push-triggered
  Cancel-on-Supersede), `claim` (OCC-protected: claims a `pending` job and
  transitions it to `running`; the loser of a race returns `false`),
  `setSiblingShas`, `setConfidenceScore`, `markCompleted`, `markFailed`,
  `markSuperseded`, `getStatus`, and the `subscribePending` query the worker
  subscribes to.
- **pullRequests** — `upsert`, `setReviewActive`, `clearOnClose`.
- **findings** — `recordFinding`, `recordSynthesizedReview`, `markPosted`,
  `listForPr`.
- **learning loop** — `archetypes:assignOrCreateArchetype`, `byProduct`,
  `updateSuppressionWeight`, and a no-op `clusterRecentFindings` compatibility
  action for old manual triggers.
- **agentRuns** — `record`, which also links the run back onto its ReviewJob.
- **crons** — `reapStuckJobs` runs every 5 minutes and marks `running`
  ReviewJobs claimed more than 30 minutes ago as `failed`; SuggestedRule
  inference runs daily.

## Local setup

This package needs a Convex deployment before it can generate types, type-check,
or deploy — `convex codegen` refuses to run without `CONVEX_DEPLOYMENT`:

```bash
# One-time: log in and create/link a deployment (writes .env.local).
pnpm --filter @sandy/convex-backend exec convex dev --once

# Regenerate convex/_generated (also happens continuously under `convex dev`).
pnpm --filter @sandy/convex-backend build

# Type-check (requires _generated) and deploy.
pnpm --filter @sandy/convex-backend type-check
pnpm --filter @sandy/convex-backend deploy
```

Commit `convex/_generated/` once generated (Convex convention) so dependent
packages type-check without a live deployment. Full walkthrough:
`docs/setup/convex.md` (issue #3).
