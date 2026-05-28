# Phase 1 — First Useful Review

Status: Draft
Owner: Tony
Target: First working end-to-end review against one Product / one Repo / one Agent.

## Goal

Ship the smallest deliverable that proves Sandy works at all: a registered GitHub App fires a webhook → Sandy enqueues a ReviewJob in Convex → the worker on the host claims it → Sandcastle spawns ONE Agent (logic) inside an Apple Container → the Agent emits structured Findings → Sandy posts inline comments + a summary to the PR.

No multi-agent fan-out, no API surface manifest, no learning loop, no cross-repo manifest. Single Product, single Repo, single Agent.

## What ships

### Infrastructure (one-time setup, documented)

- Registered GitHub App "Sandy" with these webhook events: `pull_request`, `issue_comment`, `pull_request_review_comment`, `push`. Permissions: pull_requests (read+write), contents (read), metadata (read).
- Convex Cloud deployment with the Phase 1 schema deployed.
- Tailscale Funnel on the host pointing at port 3007.
- Apple Container image built from the Sandy Dockerfile, including `opensrc` global install.
- launchd plist installed for the worker process; runs on boot.

### Code packages

**`packages/shared-types/`** — Pure TypeScript types, no runtime code.
- `Product`, `Repo`, `PullRequest`, `ReviewJob`, `Finding`, `AgentDefinition`, `AgentRun`, `FindingsPayload` (the JSON shape Agents emit).

**`packages/convex-backend/`**
- `schema.ts` — tables: `products`, `repos`, `pullRequests`, `reviewJobs`, `findings`, `agentRuns`. (Archetype / reaction / suggestedRules tables land in Phase 3.)
- `pullRequests.ts` — mutations: `upsert`, `setReviewActive`, `clearOnClose`.
- `reviewJobs.ts` — mutations: `enqueue`, `claim` (OCC-protected), `markRunning`, `markCompleted`, `markFailed`, `markSuperseded`; query: `subscribePending`.
- `findings.ts` — mutation: `recordFinding`; query: `listForPr`.
- `crons.ts` — `reapStuckJobs` every 5 min (mark `running` jobs older than 30 min as `failed`).
- `convex.config.ts`.

**`packages/apple-container-provider/`** — Apple Container `SandboxProvider` for `@ai-hero/sandcastle` (copied from graindevue per ADR 0009).
- `src/apple-container.ts`, `src/mount-utils.ts`, `src/apple-container.test.ts` — copied from `~/projects/graindevue/.sandcastle/`, re-licensed MIT, with an origin/attribution header. Exports `appleContainer(options): SandboxProvider` matching sandcastle's contract.
- Own `package.json`, `tsconfig.json`, `vitest.config.ts`. Wired as a workspace dependency of `@sandy/bot-worker`. The Dockerfile is NOT copied — Sandy ships its own (ADR 0009).

**`packages/bot-worker/`**
- `src/main.ts` — entry point.
- `src/webhook/server.ts` — HTTP server on port 3007, verifies GitHub App webhook signatures.
- `src/webhook/dispatch.ts` — routes events to handlers.
- `src/webhook/trigger-evaluator.ts` — Sticky Opt-In logic: enqueues only when `reviewActive=true` OR the event is an `@bot review` mention OR `gh pr ready`.
- `src/worker/claimant.ts` — subscribes to Convex `subscribePending`, claims jobs via OCC.
- `src/worker/sandcastle-runner.ts` — wraps `@ai-hero/sandcastle` (using `@sandy/apple-container-provider`) to spawn one Agent in an Apple Container, mounts the worktree, captures stdout.
- `src/worker/findings-parser.ts` — extracts the `<findings>...</findings>` JSON block from Agent output and validates against `FindingsPayload`.
- `src/worker/poster.ts` — posts inline comments + summary via Octokit, each with the HTML trailer `<!-- bot:finding=<id> -->`.
- `src/config/loader.ts` — reads `.config/bot.yaml`, validates Products/Repos, loads Agent definitions from `agents/*.md` (with overrides from `.config/agents/`).
- `src/git/clone-manager.ts` — clones registered Repos on first observation, fetches updates on push, creates per-Review worktrees via `git worktree`.

### Documentation

- `docs/setup/github-app.md` — App registration walkthrough.
- `docs/setup/convex.md` — schema deployment.
- `docs/setup/tailscale.md` — Funnel configuration.
- `docs/setup/sandcastle-image.md` — Dockerfile + image build + opensrc install.
- `docs/setup/launchd.md` — plist template with paths.
- `docs/setup/bot-yaml.md` — `.config/bot.yaml` schema reference.

### Active Agent

Only `agents/logic.md` runs in Phase 1. The other shipped Agents (`security.md`, `style.md`, etc.) are present but unused until Phase 2 activates fan-out.

## Out of scope (deferred)

- Parallel multi-agent fan-out → Phase 2
- API surface manifest → Phase 2
- Per-repo `.bot/` config reading → Phase 2
- Framework-version Extractor → Phase 2
- Embedding clustering, archetypes, suppressions → Phase 3
- Reaction webhooks driving learning → Phase 3
- SuggestedRules + promotion workflow → Phase 3
- `@bot focus` / `@bot ignore` commands → Phase 4
- "Fix in Claude Code" prompt blocks → Phase 4

## Acceptance criteria

- [ ] PR opened against a registered Repo with `reviewActive=false` → no Sandy activity in logs/Convex.
- [ ] `@bot review` comment → ReviewJob enqueued, `reviewActive` flipped to true, logic Agent runs in an Apple Container, at least one comment posted (or a clean "no issues found" summary).
- [ ] Subsequent push to the same PR → new ReviewJob enqueued automatically without re-mentioning the bot.
- [ ] Push landing during an in-flight Review → in-flight ReviewJob marked `superseded`, its container torn down, fresh job started on new HEAD.
- [ ] PR close → `reviewActive` cleared in Convex.
- [ ] launchd restarts the worker process after `kill -9`; no leaked Apple Containers after restart.
- [ ] Posted comments include the HTML trailer (verified by viewing page source).
- [ ] Tailscale Funnel URL receives the GitHub webhook; signature verification rejects requests with bad/missing signatures.

## Dependencies

- `@ai-hero/sandcastle` (npm)
- `@octokit/auth-app`, `@octokit/rest`
- `convex` client SDK
- `opensrc` installed on the host machine and in the container image

## Open questions

- Should the worker restart on `bot.yaml` change or hot-reload? **Recommendation:** SIGHUP triggers reload; no automatic file-watch in v1.
- Max diff size before Sandy declines to review? **Recommendation:** 5000 changed lines; post a "diff too large, request a smaller scope" comment instead.
- PRs from forks (head SHA in a different Repo)? **Recommendation:** v1 declines, documents the limitation, addresses in a later phase.

## Sequencing within Phase 1

1. `shared-types/` — depended on by everything else.
2. `convex-backend/` schema + functions — depended on by the worker.
3. `apple-container-provider/` — copy + test the provider in isolation (its unit tests pass without the rest of Sandy); `bot-worker`'s sandcastle-runner depends on it.
4. `bot-worker/` — built bottom-up: clone-manager → config-loader → sandcastle-runner → findings-parser → poster → webhook/server → main.ts.
5. Setup docs in parallel with the worker.
6. Manual end-to-end test against a private test Repo before the first real Product is registered.
