# Deploying the Convex backend

Sandy keeps its queue and review state in **Convex Cloud** (ADR
[0004](../adr/0004-convex-cloud-for-state.md)). The schema and functions live in
[`packages/convex-backend`](../../packages/convex-backend); this walkthrough
creates a deployment and pushes that schema to it.

This is also a prerequisite for type-checking the rest of the workspace:
`convex codegen` writes `convex/_generated/`, which dependent packages import.
See the package's own [`README.md`](../../packages/convex-backend/README.md) for
the function inventory — this doc covers the deployment steps and does not
restate it.

## 1. Log in and create a deployment

From the repo root. The first `convex dev` run prompts you to log in (browser
OAuth) and to create or link a deployment, then writes the deployment name into
`packages/convex-backend/.env.local` (gitignored):

```bash
pnpm --filter @sandy/convex-backend exec convex dev --once
```

Choose a new project (e.g. `sandy`) when prompted. `--once` performs a single
codegen + push and exits, which is what you want for setup; drop it to keep a
watcher running while developing the backend.

> **Where the URL goes.** `convex dev` records `CONVEX_DEPLOYMENT` in
> `.env.local`. The worker reads its own `CONVEX_URL` from `.config/.env` — copy
> the deployment URL Convex prints (the `https://<name>.convex.cloud` value) into
> `.config/.env` alongside the GitHub App credentials from
> [`github-app.md`](./github-app.md):
>
> ```bash
> # .config/.env (append)
> CONVEX_URL=https://your-deployment.convex.cloud
> ```

## 2. Generate types and deploy the schema

`convex dev --once` already generated `convex/_generated/` and pushed the schema
to your **dev** deployment. To regenerate types explicitly, type-check, and push
to the deployment:

```bash
# Regenerate convex/_generated (also runs continuously under `convex dev`).
pnpm --filter @sandy/convex-backend build

# Type-check against the generated types.
pnpm --filter @sandy/convex-backend type-check

# Deploy schema + functions.
pnpm --filter @sandy/convex-backend deploy
```

`convex deploy` pushes to your **production** deployment for the project. For a
solo self-hosted setup the dev deployment is usually sufficient; point the
worker's `CONVEX_URL` at whichever deployment you intend to run against.

> Commit `convex/_generated/` once generated — this is the Convex convention and
> lets dependent packages type-check without a live deployment. The
> `convex-backend` README says the same; don't delete it from version control.

## 3. What gets deployed

The Phase 1 schema defines six tables — `products`, `repos`, `pullRequests`,
`reviewJobs`, `findings`, `agentRuns` — and the mutations/queries the worker
uses to enqueue and claim a ReviewJob, flip a PR's `reviewActive` flag, and
record Findings. The `reviewJobs.claim` mutation is OCC-protected so two worker
subscribers can't claim the same `pending` job.

Tables for Archetypes, Reactions, and SuggestedRules are **not** in this schema
— they arrive in Phase 3 with the learning loop. The `reapStuckJobs` cron (marks
long-`running` jobs `failed`) lands with operational hardening in a later issue,
not here.

## 4. Verify

The Convex dashboard (`npx convex dashboard` from
`packages/convex-backend`, or <https://dashboard.convex.dev>) should show the six
tables under **Data** and the `pullRequests` / `reviewJobs` / `findings`
functions under **Functions**. The tables are empty until Sandy observes its
first PR.

## Next

Register the [GitHub App](./github-app.md) (if you haven't), then expose the
worker via [`tailscale.md`](./tailscale.md).
