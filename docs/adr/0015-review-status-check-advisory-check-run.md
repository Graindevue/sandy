# 15. Sandy reports Review progress as a single advisory GitHub Check Run

Date: 2026-06-04

Status: Accepted

> **Runtime amendment (2026-10-09).** The advisory Check Run and outcome mapping remain. ADR 0018 moves execution to Actions and retires push-driven superseding cancellation. Check Run re-request is a best-effort trigger under GitHub's Actions event restrictions; mentions and manual dispatch remain available.

## Context

While a Review runs, the PR page shows nothing. Sandy's only PR-page artifacts are the inline Finding comments and the summary issue comment (`poster.ts`), and those appear only *after* a Review finishes. A Review can take minutes (clone, manifest build, N agents in Apple Containers, synthesis), during which an operator looking at the PR has no signal that Sandy is working, queued, or done — let alone what it concluded. The reviewed-PR merge box is where that "is anything happening?" signal belongs.

GitHub offers two mechanisms for a row in the merge box:

- **Commit Status** (`POST /statuses/{sha}`) — `pending|success|failure|error`, a short context label, a ≤140-char description, one link. Permission `statuses: write`. No rich body; `pending` is a static dot that cannot distinguish *queued* from *running*; no re-run affordance.
- **Check Run** (`POST /check-runs`) — `queued|in_progress|completed` + a `conclusion`, a markdown `output`, a `details_url`, and a built-in **Re-run** button. Permission `checks: write`. A live in-progress spinner, updated in place by id.

Layered on the mechanism choice are policy questions: one check or one per Agent; whether a Finding can turn the check red (and thereby gate a merge if the check is ever marked required); and what "completed" means given that the `ReviewJob` lifecycle (`pending → running → completed | failed | superseded`) does not, by itself, distinguish a clean Review from one where every Agent crashed (per-Agent failures are swallowed by `Promise.allSettled` and the job still reaches `markCompleted`).

## Decision

Sandy publishes **one Check Run per ReviewJob**, named **Sandy**, created and updated entirely from the worker (the executor, at claim time), with its id persisted on the ReviewJob. It is **advisory** — it reports state and a verdict but is never intended to gate a merge on Findings.

- **Check Run over Commit Status.** The in-progress spinner is exactly the "Sandy is running" signal the gap is about, and the richer status model (queued/in-progress/completed, re-run) is worth the extra `checks: write` permission and tracking one check-run id.
- **One aggregate check, not one per Agent.** The check maps to the *Review* unit. The visible check set stays stable per PR (per-Agent checks would vary by repo/config — awkward for a required check) and the merge box stays clean. Per-Agent detail, where surfaced, belongs in the body, not in extra merge-box rows.
- **Findings never block; only Sandy breaking is loud.** Conclusion mapping, computed from the actual outcome the executor holds — not from the bare job status:
  - clean Review (all Agents ran, zero Findings) → `success`
  - Review with Findings → `neutral`
  - any Agent failed but others posted results → `neutral` (green is reserved for "all Agents ran clean"; a partially-degraded Review must not read as all-clear)
  - **every Agent failed**, or the job hit `markFailed` → `failure` (the one genuinely red state)
  - over the changed-line limit (scope-declined) → `skipped`
  - superseded by a newer push → `cancelled`
- **`details_url`** points at the PR while in-progress, then at the summary-comment permalink once posted, so "Details" jumps to the evidence.
- **The Re-run button is a Review trigger.** Subscribe to the `check_run` event; `rerequested` enqueues a fresh ReviewJob for the current head, a sibling to `@bot review`.

This adds the `checks: write` permission and the `check_run` event to the GitHub App (`docs/setup/github-app.md`), a `checkRunId` field + `setCheckRunId` mutation on `reviewJobs`, and a `createCheckRun`/`updateCheckRun` pair on `GitHubAppClient`.

## Consequences

- **The PR page shows evidence the whole time** — queued/running spinner, then an at-a-glance verdict — instead of staying empty until comments land.
- **Sandy never silently ships a green check over a dead Review.** Because the conclusion is computed from Agent outcomes, the "all Agents failed but the job is `completed`" path resolves to `failure`, closing the silent-failure hole the executor would otherwise leave.
- **Sandy will not block a merge on its own judgment.** A Finding is at most `neutral`; only Sandy *breaking* is `failure`. An operator who later marks the **Sandy** check *required* is opting into "a Sandy outage blocks merges" — a deliberate, separate choice, not a default. This matches Sandy's advisory posture and the still-learning suppression loop: gating merges on model Findings while false positives are still being learned out is the trap this avoids.
- **All GitHub I/O stays in the worker.** Convex remains pure reactive state (ADR 0004); the App private key never reaches Convex Cloud. The cost is that a PR waiting behind another under the concurrency cap has no check until it is claimed — there is no `queued` row in v1.
- **Check posting is best-effort.** A failed check call is logged and swallowed, exactly as comment posting is (`poster.ts`); it never fails the Review or blocks comments.
- **The body is minimal in v1** — a one-line verdict plus a link to the summary comment. Per-Agent and cross-repo-search health stay in the agent output / comment; promoting them into the check body is a later, additive change.

## When to revisit

- **Add a `queued` state** by moving check creation earlier (the webhook dispatcher, which already holds the GitHub client) so PRs waiting behind the concurrency cap also show evidence. The `checkRunId` field and PATCH paths are unchanged — a strict extension, not a rewrite.
- **Enrich the body** (per-Agent status table, cross-repo searched/skipped rationale, confidence score) if the minimal verdict proves too thin in daily use.
- **Reconsider a blocking conclusion** only if the suppression loop matures to where gating on a severity threshold carries an acceptable false-positive rate — a deliberate move from advisory to gate, owned by a future ADR.
