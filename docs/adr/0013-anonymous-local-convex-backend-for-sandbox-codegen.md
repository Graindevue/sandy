# 13. Anonymous local Convex backend for sandbox codegen

Date: 2026-05-31

Status: Accepted

## Context

Sandcastle agents (implementer, reviewer, merger) run in offline-ish Linux
sandboxes with no Convex login. In Convex 1.39, `convex codegen` is **not** an
offline operation — it connects to a deployment ("Downloads current deployment
state… Uploads functions to Convex…"). With no deployment configured, the
`pnpm --filter @sandy/convex-backend build` script (`convex codegen`) fails with
`CONVEX_DEPLOYMENT is unset`, so the prompts told agents *not* to run it
(`merge-prompt.md` formerly: "Convex codegen needs a live deployment and will
fail here").

The committed `convex/_generated/` keeps `pnpm type-check` / `pnpm test` green,
so the build failure was silent. The real hole it left open: an agent edits
`convex/schema.ts`, cannot regenerate `_generated/`, and commits **stale
generated types**. Type-check then passes *against the stale types*, and the
schema↔`_generated` drift lands on `staging` undetected.

## Decision

Each sandbox provisions an **anonymous local Convex backend**
(`convex-local-backend`, no account, no secret) used solely for codegen and
drift verification:

- `CONVEX_AGENT_MODE=anonymous` is set in the sandbox provider env (the
  documented agent recipe). With it, `convex dev --once` non-interactively
  configures an anonymous local deployment, starts the backend, and codegens —
  no TTY prompts.
- The `convex-local-backend` binary is provisioned via a bind-mounted host cache
  (`.sandcastle/convex-cache → ~/.cache/convex`), mirroring the existing
  `.sandcastle/pnpm-store` mount: downloaded once, reused by every sandbox. The
  anonymous deployment *state* lives in each container's own `~/.convex/`, so
  parallel sandboxes are isolated (each backend on the default port in its own
  network namespace).
- The `onSandboxReady` hook runs `convex dev --once --typecheck disable` to
  configure the deployment and warm the binary, so the existing
  `pnpm --filter @sandy/convex-backend build` (`convex codegen`) works unchanged
  for agents and the merger thereafter.
- Drift is handled **layered**: the implementer/reviewer regenerate `_generated/`
  during their own run (so their tests run against correct types), and the merge
  gate re-runs codegen as a safety net — if `_generated/` still drifts it commits
  the regenerated output and logs it, and the branch still lands.

Tests are unaffected: the convex package's tests use in-memory fake `ctx`, so no
live deployment is needed for `pnpm test`.

## Considered options

- **Cloud preview deployments** (`convex deploy` with a preview
  `CONVEX_DEPLOY_KEY`, `--preview-create <branch>`) — the literal "spawn a staging
  env per branch" model. Rejected: `convex codegen` **explicitly refuses** a
  preview deploy key ("Codegen requires an existing deployment so doesn't support
  CONVEX_DEPLOY_KEY"), so it cannot do codegen at all. It would also put a deploy
  key secret in every sandbox, create real cloud deployments per issue branch
  (lifecycle, quota, cleanup, shared project state), and add a network dependency
  on Convex Cloud to every run.
- **Keep skipping codegen in-sandbox** (status quo) — rejected: leaves the schema
  drift hole open.

## Consequences

- This introduces a **self-hosted (local) Convex backend** for the sandbox
  codegen path specifically — a deliberate, scoped deviation from
  [ADR-0004](./0004-convex-cloud-for-state.md), which chose Convex *Cloud* for
  durable state and *deferred* self-hosting. ADR-0004 still governs Sandy's
  runtime state; this ADR only covers throwaway codegen in CI sandboxes. It is
  one of the "revisit self-hosting" triggers ADR-0004 anticipated, narrowed to
  CI.
- First sandbox on a fresh host pays a one-time binary download (version resolved
  via `version.convex.dev`, with a cached fallback when offline); subsequent
  sandboxes reuse the mounted cache.
- The convex package's generated output must stay deterministic across the local
  backend and whatever deployment last produced the committed `_generated/`;
  since codegen derives the generated files from local `convex/` source for the
  pinned convex npm version, the local-backend output matches the committed
  files, so the warm step normally produces no diff.
