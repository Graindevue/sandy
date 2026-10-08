# Deploying the Convex backend

Convex Cloud holds ReviewJobs, Findings, manifests, and Agent Run history.
The Actions entry point uses `ConvexHttpClient` for the same mutations and
queries that back this state; no persistent subscription worker is required.

## Create or link a project

From the Sandy root:

```bash
pnpm install
pnpm --filter @sandy/convex-backend exec convex dev --once
```

Follow the Convex login/project prompts. This writes the development deployment
configuration to `packages/convex-backend/.env.local` and regenerates
`convex/_generated/`.

## Deploy and configure the caller

Review and commit generated type changes alongside backend changes, then deploy:

```bash
pnpm --filter @sandy/convex-backend type-check
pnpm --filter @sandy/convex-backend deploy
```

`convex deploy` targets the project's production deployment. Use its printed
`https://<deployment>.convex.cloud` URL for the caller's `CONVEX_URL` secret:

```bash
gh secret set CONVEX_URL --repo Graindevue/graindevue
```

The prompt accepts the deployment URL. For local development, it can also live
in gitignored `.config/.env`. Ordinary CI and reviews use committed generated
types, so neither requires a deploy key or a running anonymous backend.
See [the package codegen guide](../../packages/convex-backend/README.md).

## Verify

Inspect the [Convex dashboard](https://dashboard.convex.dev) for the schema
tables and the `reviewJobs`, `pullRequests`, `findings`, and `agentRuns`
functions. After a review, verify its ReviewJob and Agent Runs are stored.

The reaper cron marks abandoned running Reviews as failed; the
SuggestedRule-inference cron remains for historical learning data. New Finding
embeddings and Archetype assignment are disabled in the Actions runtime, so
there is no embedding service or embedding API key to configure.
