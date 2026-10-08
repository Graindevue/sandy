# 18. GitHub Actions reviews with Codex subscription auth

Date: 2026-10-09

Status: Accepted

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
now private `Graindevue/sandy`, preserving the original history. The caller
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
credential directories. The review entry point enforces an overall deadline
below the existing abandoned-Review reaper cutoff.

Each persona runs once with `codex exec --json`, receiving its diff and context
up front. A missing completion signal permits one resume of that same session;
it does not restart an unbounded prompt loop. The runner parses JSONL final
messages and usage and terminates its subprocess when aborted or timed out.

## Authentication and serialization

This private automation uses a dedicated ChatGPT-managed Codex login. The user
creates it in a separate `CODEX_HOME`, with file-backed credentials, rather than
copying their interactive login. Quota comes from the ChatGPT plan; this is not
an API billing path.

Following [OpenAI's CI/CD auth procedure](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
the runner seeds a missing `auth.json`, lets Codex refresh it, and persists the
updated file after the job, including failed reviews. One global concurrency
group serializes Reviews, and Agents within a Review also run serially because
they share the same rotating refresh token. Running reviews are not cancelled
by later requests.

`CODEX_AUTH_JSON` is an **environment secret** in `sandy-codex`, rather than a
repository secret. GitHub reads repository secrets when a workflow is queued,
but environment secrets when its job starts; queued Reviews must receive the
auth refreshed by the preceding Review. The App therefore needs repository
**Environments: read & write** for secret write-back. Every workflow sharing
this auth stream must use the same environment and serialization policy.

## Retained and retired behavior

Reviews stay manual-only: a PR review mention, Check Run re-request, or
`workflow_dispatch` with a PR number. Pushes and PR lifecycle transitions do not
start Reviews. Check Run re-request remains subject to GitHub's Actions event
delivery restrictions; mentions and dispatch are the dependable fallback.
The superseding container-cancellation mechanism is retired: Actions serializes
requests, and each Review resolves the PR head when it begins.

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
correct token rotation over concurrent persona latency, and subscription limits
still bound review throughput. A failed auth write-back is an operational
failure requiring repair before another Review can safely reuse the stream.
