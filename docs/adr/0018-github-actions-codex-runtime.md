# 18. GitHub Actions reviews with Codex subscription auth

Date: 2026-10-09

Status: Accepted; trigger policy updated to standalone `@sandy` comments;
Review-scoped concurrency remains an opt-in rollout.

Supersedes [0003](./0003-sandcastle-runtime-no-fork.md) and
[0009](./0009-apple-container-provider-copied-from-graindevue.md).
Amends [0004](./0004-convex-cloud-for-state.md),
[0008](./0008-opensrc-for-framework-source-truth.md),
[0010](./0010-cross-repo-access-via-mounted-sibling-worktrees.md),
[0013](./0013-anonymous-local-convex-backend-for-sandbox-codegen.md), and
[0017](./0017-manual-only-review-triggering.md) where they describe execution.

Sandy's local service depended on an always-on Mac, webhook ingress, and Apple
Container lifecycle management. Sandcastle's repeated completion-signal loop
also consumed too much subscription quota for review workloads. We move review
execution to a one-shot GitHub Actions job on `ubuntu-latest`, using Codex CLI
directly and retaining Convex Cloud for durable state.

## Execution and state

The caller checks out trusted Sandy code and runs its composite action. The
initial cross-owner setup used private `tony-co/sandy`; the canonical source is
`Graindevue/sandy`, preserving the original history. Its source is currently
public; ChatGPT-managed automation remains confined to private caller Repos. The caller
checks out an audited Sandy commit with explicit read access and invokes the
local composite rather than a private cross-owner reusable workflow.

The entry point resolves the current PR, registers Product configuration,
creates and claims a ReviewJob, and calls the existing ReviewExecutor through
its `ReviewExecutionStore`, `ReviewAgentRunner`, `ReviewPoster`, and
`ReviewDiffInspector` interfaces. The store uses `ConvexHttpClient`; Actions
provides scheduling, so no reactive claimant or persistent webhook receiver is
needed. Existing Findings, Checks, manifests, sibling revision references, and
token-usage history remain durable in Convex.

Reviewed install and test commands execute in a credential-free Codex sandbox.
Review agents use an explicit filesystem profile that permits the review
workspace while denying auth files, the App key, instance config, and other
credential directories. Linux uses explicit grants for required system reads,
review-worktree and temporary cache writes, and read-only shared Git metadata
and sibling sources. Scoped mounts avoid broad host-root reads that remap cache
ancestor ownership incompatibly with native tools such as SWC. macOS retains
the `:workspace` profile with the same credential denies. The review entry point
enforces an overall deadline below the existing abandoned-Review reaper cutoff.

Serial execution uses `codex exec --json` for each persona, receiving its diff
and context up front. A missing completion signal permits one resume of the
same thread; it does not restart an unbounded prompt loop. The runner parses
final messages and usage and terminates child activity on abort or timeout.

### Issue #4 amendment: prepared downloads and independent threads

Preparation may restore verified npm or pnpm download stores, keyed by the
reviewed lockfile and install configuration, Repo, platform, Node compatibility,
and exact package-manager version. Every Review still performs a fresh frozen
installation inside the credential-free sandbox. Unsupported or unverified
stores remain cold; cache failures are optional, and an unusable restored store
is discarded before one bounded cold retry. Only successful preparation can
publish downloads. Installed trees, source, tool homes, credentials and mutable
Review outputs are excluded.

The key is derived from the actual reviewed head's files, rather than the
caller's default branch. Revisions with identical installation inputs can
reuse downloads; source revisions are not themselves cache-key components.
Restoration uses the exact key without fallback keys. The v3 namespace includes
installation platform policy and libc. Pinned pnpm 12 prepares only native
platform artifacts through its JSON environment override, preserving all dependency
categories and frozen inputs; other versions retain repository policy. Both fetch
and install use the same policy. Registry metadata is disposable, and reviewers
are told that cross-platform installation is deferred to repository CI.

The hardened issue-comment caller grants `cache-mode: write` on its authorized
review job, rather than relying on `actions: write` or trusted-trigger defaults.
Only validated, pre-lifecycle download snapshots are published. Mutable framework
sources are restore-only. Updating the caller template is part of rollout.

The optional parallel adapter owns one Codex app-server for a Review. Sandy
admits selected Agents up to a positive cap (three initially in parallel mode),
creates a fresh thread for each, and preserves its configured persona, model,
effort and usage. The managed runtime owns transport and authentication; Sandy
owns scheduling, trusted attribution, persistence and deterministic synthesis.
There is no model coordinator. A cap of one selects serial rollback.

Dependencies are prepared once, then each admitted Agent receives a private
writable copy of the source and installation. Internal dependency links follow
the private copy; files are independent or copied on write, never hardlinked
for mutable sharing. Seed source, pinned sibling source and Git metadata remain
read-only. Tool homes, temporary files and writable caches are private. A
timeout starts on admission rather than while waiting in the queue.

Before populating the private workspace inventory, Sandy measures seed
file sizes without following links, budgets ordinary copies (including duplicated
hardlinks), and reserves 1 GiB per admitted Agent for builds and outputs. Every
selected Agent gets a distinct reserved root before runtime startup for
peer deny rules, but only the admitted window receives copies. Completed copies
are released while their empty roots survive until shutdown. A lower cap reduces
resident copies without reusing a writable root. Insufficient capacity reduces
the parallel cap when at least two copies fit, otherwise selects serial mode;
unavailable preflight selects serial mode before copying. ENOSPC/EDQUOT before
admission remains a cleanup-and-serial fallback for races. Later copy failures
retain partial-review failure semantics.
Posted summaries disclose requested and effective concurrency, fallback reasons,
storage estimates, cache outcomes and bounded sanitized preparation errors.

Completed outcomes are persisted independently and synthesis reconstructs the
selected-Agent order. Agent failures retain healthy peers and completed
findings. A runtime crash fails affected active and queued work explicitly;
there is no silent restart or second investigation. Cancellation and deadline
expiry stop admission, interrupt active turns, drain final events and await
runtime shutdown before removing workspaces or persisting authentication.
Partial Reviews are visibly incomplete and cannot appear as an all-clear.

The preferred adapter is validated against deployed Codex **0.162.0**, including
its generated experimental protocol. Compatibility fallback occurs only before
Agent execution. Serial remains the production default: exact-pin protocol
fixtures establish mechanics, while promotion additionally requires real Linux
isolation, dedicated-login refresh and writeback, matched latency measurements
and adjudicated finding-quality gates. The
[rollout report](../benchmarks/review-speed.md) records evidence and blockers.
Changing prompts, models or coverage is not part of this comparison.

## Authentication and serialization

This private automation uses a dedicated ChatGPT-managed Codex login. The user
creates it in a separate `CODEX_HOME`, with file-backed credentials, rather than
copying their interactive login. Quota comes from the ChatGPT plan; this is not
an API billing path.

Following [OpenAI's CI/CD auth procedure](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
the runner seeds a missing `auth.json`, lets Codex refresh it, and persists the
updated file after the job, including failed reviews. One concurrency group on
the eligible review job serializes whole Reviews and every job using the login.
Serial exec remains the default. Optional parallel threads run inside one
managed process with one authentication owner, rather than independent CLI
processes competing to rotate the refresh token. Running Reviews are not
cancelled by later requests.

`CODEX_AUTH_JSON` is an **environment secret** in `sandy-codex`, rather than a
repository secret. GitHub reads repository secrets when a workflow is queued,
but environment secrets when its job starts; queued Reviews must receive the
auth refreshed by the preceding Review. The App therefore needs repository
**Environments: read & write** for secret write-back. Every workflow sharing
this auth stream must use the same environment and serialization policy.

The isolated issue #4 benchmark uses a different dedicated login in
`Graindevue/graindevue` environment `sandy-codex-test`, with whole-job lock
`sandy-codex-test-session`. It never copies the production login. Its manual
workflow runs pinned disposable fixtures without Convex or PR posting and
persists the test session even when measurements fail. This does not enable
parallel production reviews. See [benchmark setup](../setup/review-benchmark.md).

## Retained and retired behavior

Reviews start only from a newly created PR comment containing standalone
`@sandy`, authored by an authorized human collaborator with repository write
access. The event is `issue_comment: created`; edited comments, Check Run
re-requests, workflow dispatch, pushes, and PR lifecycle changes do not start
Reviews. No `review` suffix is required, and `@agent-sandy` is not an alias.
The workflow gate and request validator accept only Actions run attempt `1`;
rerunning a previous workflow cannot replay its mention. Another Review needs
a new `@sandy` comment.
The earlier multi-trigger Actions policy is superseded by this single request
path, as recorded in the updated ADR 0017.
The superseding container-cancellation mechanism is retired: Actions serializes
requests, and each Review resolves the PR head when it begins.
Each summary prominently names the reviewed commit and directs the author to
post a new `@sandy` comment after new commits to request another Review.

Product sibling source remains available at pinned default-branch revisions in
the runner filesystem. `opensrc` remains available for finding-gated framework
verification, with Actions caching replacing the host-mounted cache.
The custom `tree_sitter_query` executable, native tree-sitter rebuilds, and RTK
image build are retired. Current Manifest Extractors use source-text and
package-metadata scans without native parser bindings.

Embeddings and new Archetype assignment are disabled via
`disabledArchetypeAssigner`; historical learning state is retained. Feedback
collection and Rule promotion require a future explicit job rather than a
reactive daemon. No Ollama service is provisioned.

Committed `convex/_generated/` supports ordinary CI and review execution without
starting a backend or deploying code. Developers editing Sandy's backend still
regenerate types against a dev deployment or an isolated anonymous local
backend, as described in the amended ADR 0013. Reviews never receive a Convex
deployment key merely to run codegen.

The Sandcastle dependency, Apple Container provider, container images, local
HTTP server, launchd/Tailscale setup, and `.sandcastle` implementation harness
are removed. Other VM hosting options were rejected because they retain service
maintenance without improving this manually requested, finite-job workload.

## Consequences

Operational state is cloud-based and Reviews work while the laptop is offline.
Codex CLI output parsing becomes Sandy's responsibility, with focused tests
covering completion, resume, usage, and abort behavior. Shared auth favors
correct token rotation at the job boundary; opt-in child concurrency can reduce
persona latency without removing that boundary. Subscription limits still
bound review throughput. A failed auth write-back is an operational
failure requiring repair before another Review can safely reuse the stream.
