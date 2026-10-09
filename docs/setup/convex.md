# Deploying the Convex backend

Convex Cloud holds ReviewJobs, Findings, manifests, and Agent Run history.
The Actions entry point authenticates `ConvexHttpClient` with short-lived
GitHub Actions OIDC tokens. Every public function rejects anonymous requests
and identities outside the deployment's configured trusted review job.

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

Configure the identity of the private caller **before** deploying the protected
functions. Use the immutable repository ID, the exact workflow file on its
trusted default branch, and the environment name. For the existing caller:

```bash
pnpm --filter @sandy/convex-backend exec convex env set SANDY_AUTH_REPOSITORY_ID 754253936
pnpm --filter @sandy/convex-backend exec convex env set SANDY_AUTH_WORKFLOW_REF 'Graindevue/graindevue/.github/workflows/sandy-review.yml@refs/heads/main'
pnpm --filter @sandy/convex-backend exec convex env set SANDY_AUTH_ENVIRONMENT sandy-codex
```

These values are public identity metadata, not credentials. For another caller,
get its ID with `gh api repos/OWNER/REPO --jq .id` and replace all three values.
The existing Graindevue caller currently uses the linked development deployment;
the commands above target that deployment. Add `--prod` for a caller using the
production deployment. Check that the
deployment URL matches the caller's `CONVEX_URL` before changing a deployment.
Unset values fail closed.

Each deployment belongs to one trusted Sandy service, which may manage its
Product and sibling Repos from trusted configuration. Do not share a deployment
between mutually untrusted callers: this identity authorizes the complete
service API, rather than a human or tenant account. Repository renames, default
branch changes or workflow moves require updating
the trust configuration.

Review and commit generated type changes alongside backend changes, then deploy
to the same deployment you configured:

```bash
pnpm --filter @sandy/convex-backend type-check
pnpm --filter @sandy/convex-backend exec convex dev --once
```

For production, first configure the three trust values with `--prod`, then run
`pnpm --filter @sandy/convex-backend deploy`. `convex deploy` targets the project's
production deployment. Use the selected deployment's printed
`https://<deployment>.convex.cloud` URL for the caller's `CONVEX_URL` secret:

```bash
gh secret set CONVEX_URL --repo Graindevue/graindevue
```

The prompt accepts the deployment URL. For local development, it can also live
in gitignored `.config/.env`. Ordinary CI and reviews use committed generated
types, so neither requires a deploy key or a running anonymous backend.
See [the package codegen guide](../../packages/convex-backend/README.md).

The caller's review job must have `id-token: write` and select `sandy-codex`.
Install the current workflow template and pin the matching Sandy commit before
requesting a review. The runtime requests tokens for the `sandy-review` audience
and refreshes them in memory as needed. Convex verifies GitHub's RS256 signature,
issuer, audience, and expiry; the function guard also checks repository ID,
workflow ref, signed environment claim, private visibility, `issue_comment`, and initial run
attempt. No Convex deploy key or permanent service token is given to Actions or
reviewed processes. See [Convex custom JWT authentication](https://docs.convex.dev/auth/advanced/custom-jwt)
and [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

Existing callers using an unauthenticated Sandy commit stop working when this
backend is deployed. Coordinate the caller workflow and Sandy pin with the
backend deployment, and let any active review finish before activation.

## Verify

Inspect the [Convex dashboard](https://dashboard.convex.dev) for the schema
tables and the `reviewJobs`, `pullRequests`, `findings`, and `agentRuns`
functions. After a review, verify its ReviewJob and Agent Runs are stored.

An HTTP query to `reviewJobs:subscribePending` with `{}` and no Authorization
header must return a JSON error with `status: "error"` and
`errorData: "Unauthorized"`. Convex can return HTTP 200 for this error, so inspect
the response body. Test this without printing private data;
successful anonymous access is a failed deployment. A trusted caller review
must still complete and persist its state. Unit tests cover every public
function and reject wrong workflow/repository/environment claims before state
access; the two learning-inference helpers are internal-only so crons continue
without impersonating an Actions identity.

The reaper cron marks abandoned running Reviews as failed; the
SuggestedRule-inference cron remains for historical learning data. New Finding
embeddings and Archetype assignment are disabled in the Actions runtime, so
there is no embedding service or embedding API key to configure.
