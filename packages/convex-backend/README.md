# @sandy/convex-backend

Convex schema and functions for Sandy's queue and review state, deployed to
Convex Cloud (ADR 0004).

## Tables

`products`, `repos`, `pullRequests`, `reviewJobs`, `findings`, `archetypes`,
`reactions`, `suggestedRules`, `agentRuns`, `apiSurfaceManifests` — see
[`convex/schema.ts`](./convex/schema.ts). Convex adds `_id` and `_creationTime`
to every row.

## Functions

Every public function uses the `convex-helpers` builders in
[`convex/serviceFunctions.ts`](./convex/serviceFunctions.ts). The deployment
trusts one private caller's GitHub Actions OIDC identity: immutable repository
ID, exact trusted workflow ref, and signed environment claim, with manual-comment
events and initial attempts only. Missing deployment configuration fails closed.
[`convex/auth.config.ts`](./convex/auth.config.ts) verifies GitHub's JWT signature,
issuer, expiry, and the `sandy-review` audience. Setup and coordinated activation
are documented in [docs/setup/convex.md](../../docs/setup/convex.md).

- **reviewJobs** — `enqueue`, `enqueueSuperseding` (Cancel-on-Supersede for
  superseding triggers), `claim` (OCC-protected: claims a `pending` job and
  transitions it to `running`; the loser of a race returns `false`),
  `setSiblingShas`, `setCheckRunId`, `setConfidenceScore`, `markCompleted`,
  `markFailed`, `markSuperseded`, `getStatus`, and the historical
  `subscribePending` query. Actions creates and claims jobs directly through
  `ConvexHttpClient`; it does not run a persistent subscription worker.
- **pullRequests** — `upsert`, `setReviewActive`, `clearOnClose`.
- **findings** — `recordFinding`, `recordSynthesizedReview`, `markPosted`,
  `listForPr`.
- **historical learning loop** — `archetypes:assignOrCreateArchetype`, `byProduct`,
  `updateSuppressionWeight`, and a no-op `clusterRecentFindings` compatibility
  action for old manual triggers.
- **agentRuns** — `record`, which also links the run back onto its ReviewJob.
- **crons** — `reapStuckJobs` runs every 5 minutes and marks `running`
  ReviewJobs claimed more than 30 minutes ago as `failed`; the SuggestedRule
  inference cron runs daily. Its reaction-read and rule-creation helpers are
  internal functions, so a scheduled run needs no Actions token.

## Local setup

Committed `convex/_generated/` supports type-checking, tests, and ordinary CI
without a live deployment. Backend edits must regenerate those files against a
development deployment before validation:

```bash
# One-time: log in and create/link a deployment (writes .env.local).
pnpm --filter @sandy/convex-backend exec convex dev --once

# Regenerate convex/_generated (also happens continuously under `convex dev`).
pnpm --filter @sandy/convex-backend build

# Type-check (requires _generated) and deploy.
pnpm --filter @sandy/convex-backend type-check
pnpm --filter @sandy/convex-backend deploy
```

Commit generated changes with their backend source changes. Full deployment
walkthrough: [docs/setup/convex.md](../../docs/setup/convex.md).

## Isolated codegen without cloud credentials

For backend edits in a disposable checkout with no `.env.local`, inherited
deployment settings, or cloud credentials, anonymous local Convex remains an
option:

```bash
CONVEX_AGENT_MODE=anonymous pnpm --filter @sandy/convex-backend exec convex dev --once --typecheck disable
```

This downloads a local backend and generates types from the checkout. It is a
development procedure, not part of running a review; the old sandbox warm hook
and AFK merge gate were removed. See amended
[ADR 0013](../../docs/adr/0013-anonymous-local-convex-backend-for-sandbox-codegen.md).

Actions reviews use `disabledArchetypeAssigner`, preserving Findings without
new embeddings or Archetype assignment. Learning tables and functions remain
available for historical data; no Ollama instance is required.
