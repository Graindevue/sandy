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
> the deployment URL Convex prints (the `https://<name>.convex.cloud` value)
> there. [`github-app.md`](./github-app.md) creates `.config/.env` with the full
> set of keys (a `CONVEX_URL=` line included); set that line to the value here.
> If you reached this doc first and the file doesn't exist yet, create it with
> just this line and `github-app.md` will fill in the rest:
>
> ```bash
> # .config/.env — set this line (github-app.md adds the GitHub keys)
> CONVEX_URL=https://your-deployment.convex.cloud
> ```

Finding evidence is embedded by the bot worker through local Ollama, so Convex
does not need an embedding API key.

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

The schema tables and the worker's mutations/queries/actions — `enqueue`/
`claim`/`record`-style functions and learning-loop assignment functions — are
inventoried in the package's own
[`README.md`](../../packages/convex-backend/README.md) and
[`convex/schema.ts`](../../packages/convex-backend/convex/schema.ts). This doc
deploys them; it doesn't restate the list. Phase 3 learning-loop tables
(`archetypes`, `reactions`, and `suggestedRules`) are present.

The `reapStuckJobs` cron runs every 5 minutes and marks ReviewJobs left
`running` for more than 30 minutes as `failed`. The SuggestedRule inference cron
runs daily after reactions have accumulated.

## 4. Verify

The Convex dashboard (`npx convex dashboard` from
`packages/convex-backend`, or <https://dashboard.convex.dev>) should show the
schema tables under **Data** and the `pullRequests` / `reviewJobs` / `findings`
functions under **Functions**, plus the `reapStuckJobs` and SuggestedRule
inference crons under **Cron Jobs**. The tables are empty until Sandy observes
its first PR.

## Next

Register the [GitHub App](./github-app.md) (if you haven't), then expose the
worker via [`tailscale.md`](./tailscale.md).
