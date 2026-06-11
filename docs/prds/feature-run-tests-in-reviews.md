# Feature — Run tests inside reviews

Status: Draft
Owner: Tony
Target: Review Agents can execute the target Repo's test suite inside the sandbox, so test-coverage and Convex findings are verified by running tests instead of guessed from the diff.

## Goal

Make the review sandbox a place where tests can actually run. Today the bot-worker
review pipeline mounts a git worktree but **installs no dependencies** — there is no
`onSandboxReady` hook in `sandcastle-runner.ts`'s `RunOptions`, so review Agents
never have `node_modules`/`vitest`. (This is distinct from the `.sandcastle` AFK
harness, which *does* install deps for building Sandy itself.) As a result the
test-coverage Agent reasons about coverage purely from the diff, and its findings
are unverified guesses that churn a PR across review rounds.

`agents/test-coverage.md` was already hardened to **gate** unverified coverage
findings (require executed tests; otherwise confidence ≤2, marked unverified). This
PRD is the other half: give the Agent the ability to actually run the tests so it
can post **verified** findings at full confidence.

## Context

- Root-cause investigation: see ADR 0017 (manual-only triggering) and the PR #236
  churn analysis. Push auto-triggering and unverified coverage findings were the two
  churn drivers; this PRD closes the second by making verification possible.
- Sandcastle supports the hook we need: `RunOptions.hooks.sandbox.onSandboxReady`
  (the AFK harness in `.sandcastle/main.mts` already uses it).

## What ships

### Dependency install in the review pipeline

- An `onSandboxReady` (or equivalent pre-fan-out) step in the bot-worker review path
  that installs the target Repo's dependencies inside the Linux sandbox before Agents
  run. macOS `node_modules` must **not** be copied in (native bindings differ); the
  install runs inside the sandbox.
- **Install once per Review, not once per lens Agent.** A Review fans out ~6 Agents
  (logic, security, convex, nextjs, style, test-coverage); a naive per-Agent
  `onSandboxReady` would pay the install cost 6×. Install into the shared worktree (or
  a shared cache) once, before/around fan-out.

### Per-Repo package-manager detection

- Sandy reviews arbitrary Repos, so the install command cannot hardcode pnpm. Detect
  the package manager from the Repo (`packageManager` field, lockfile presence:
  `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `bun.lockb`) and run the
  matching install (`pnpm install --frozen-lockfile`, `npm ci`, `yarn --immutable`,
  `bun install`).

### pnpm version self-switch fix

- Both Agent images bake `pnpm@10.0.0` via plain `npm install -g` (no corepack, no
  `.npmrc`), and pnpm 10 defaults `manage-package-manager-versions=true`. So pnpm
  tries to self-switch to the Repo's pinned version (e.g. graindevue's `pnpm@10.24.0`)
  and fails offline — exactly the "pnpm 10.24.0 binary missing" failures seen on #236.
- Bake a global `.npmrc` with `manage-package-manager-versions=false` and bump the
  baked pnpm to a current 10.x (able to read any v10 lockfile) in
  `images/agent/Dockerfile` (and `.sandcastle/Dockerfile`). Requires an image rebuild.

### Fail-loud, not silent-degrade

- If install or the test runner is unavailable, the failure must be **visible** — a
  clear signal to the Agents and ideally to the Review Status Check ("Sandy ran but
  couldn't execute tests") — not a silent fall-through to static reasoning. The
  test-coverage gate then keeps unverified findings suppressed/low-confidence.

## Out of scope (deferred)

- Full build/compile of the target Repo (typecheck, bundlers). This PRD is about
  running the **test suite**, not producing build artifacts.
- Ecosystems beyond the JS package managers above (pytest, cargo, go test) — design
  the detection to be extensible, but v1 targets the JS toolchain graindevue uses.
- A sophisticated dependency cache beyond a warm pnpm store mount.

## Acceptance criteria

- [ ] On a pnpm Repo (graindevue), a review Agent can run `vitest` / `pnpm test`
      inside the sandbox and observe real pass/fail output (no "vitest: not found").
- [ ] pnpm no longer self-switches: installing in a Repo pinned to a different
      `packageManager` version succeeds offline with the baked pnpm.
- [ ] The dependency install runs at most once per Review, not once per lens Agent.
- [ ] When deps can't be installed or no runner exists, the Review surfaces it loudly;
      the test-coverage Agent posts no full-confidence coverage finding (existing gate).
- [ ] test-coverage findings on a successful run cite the executed command + result in
      `Finding.evidence`.
- [ ] Install time is bounded (define a budget, e.g. ≤ N minutes) and respects the
      Review's abort signal.

## Dependencies

- Sandcastle `RunOptions.hooks` (confirmed available).
- Agent image rebuild (`pnpm sandcastle:build-image`) on the live worker to ship the
  pnpm/`.npmrc` change.
- Interacts with the `rtk` test-output trial (`run_tests` / `rtk`) already in the image.

## Open questions

- Shared-install mechanics: install in a host-side prep step writing Linux-native
  `node_modules` into the worktree, or a single sandbox that installs and is reused by
  all lens Agents? How do parallel Agent containers share one install without races?
- Network posture: does the review sandbox get registry access, or must installs come
  entirely from a warm, mounted pnpm store? What primes the store for a new Repo?
- Cost: multi-Agent fan-out already adds up; is per-Review `pnpm install` acceptable
  on every Review, or gated to Repos/Agents that actually need test execution?
- Should a Review hard-fail (loud "couldn't run tests") or soft-degrade to static
  review with a visible banner when test setup is impossible for a Repo?
