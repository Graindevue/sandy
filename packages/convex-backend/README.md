# @sandy/convex-backend

Convex schema and functions for Sandy's queue and review state, deployed to
Convex Cloud (ADR 0004).

## Tables

`products`, `repos`, `pullRequests`, `reviewJobs`, `findings`, `agentRuns` — see
[`convex/schema.ts`](./convex/schema.ts). Archetype / reaction / suggestedRules
tables arrive in Phase 3. Convex adds `_id` and `_creationTime` to every row.

## Functions

- **reviewJobs** — `enqueue`, `claim` (OCC-protected: claims a `pending` job and
  transitions it to `running`; the loser of a race returns `false`),
  `markCompleted`, `markFailed`, `markSuperseded`, and the `subscribePending`
  query the worker subscribes to.
- **pullRequests** — `upsert`, `setReviewActive`, `clearOnClose`.
- **findings** — `recordFinding`, `listForPr`.

The `reapStuckJobs` cron lands with Operational hardening (issue #8).

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
