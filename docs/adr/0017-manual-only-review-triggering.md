# 17. Reviews start only from new `@sandy` PR comments

Date: 2026-06-11

Status: Accepted; trigger policy updated to standalone `@sandy` comments.
Actions scheduling is recorded in [0018](./0018-github-actions-codex-runtime.md).

Supersedes [0016](0016-base-branch-exclusion.md)

## Context

Sandy's original trigger model (Sticky Opt-In) was reactive: once a PR was opted
in — by an `@bot review` mention or a `gh pr ready` transition — every subsequent
push auto-retriggered a Review. The pitch was "nothing to remember."

In practice this produced runaway review churn. On one real PR
(`Graindevue/graindevue#236`) the worker enqueued **68 ReviewJobs**: 22 from
manual `@bot review` mentions and **46 auto-fired by the author's own fix
commits**. Each fix commit re-reviewed a diff that had just changed, against a
stateless reviewer with no memory of prior rounds, so every push surfaced a fresh
slice of findings instead of converging. The reactive model actively worked
against "find everything, fix once": it rewarded tiny per-finding pushes with a
new full review each time.

The author's intent is the opposite — review when a human asks, not on every
keystroke of `git push`.

## Decision

Reviews are **manual-only**, with one request path: a **newly created PR comment
containing standalone `@sandy`**, from an authorized human collaborator with
repository write access. `@sandy` alone is sufficient; a `review` suffix is not
required. `@agent-sandy` is not an alias.

Only `issue_comment` events of type `created` can start a Review. Edited comments,
Check Run re-requests, workflow dispatch, pushes, and PR lifecycle events do not
trigger one. Rerunning an earlier Actions workflow is rejected: the workflow and
request validator require `run_attempt` to be `1`. To request another Review,
create a new `@sandy` comment. The PR must be open, private, and from the same
repository.

Actions serializes eligible review jobs and Agent Runs around one dedicated
Codex auth stream. A new request does not cancel a running Review. The review
resolves the current head when it begins and prominently identifies that commit
in its summary. After new commits, a human posts a new `@sandy` comment to request
another Review.

Earlier accepted versions offered Check Run re-requests and later workflow
dispatch alongside mentions. Those request paths and the old opt-in/container
cancellation behavior are retired; the churn rationale above still applies.

## Consequences

- The author controls review cadence. After pushing a batch of fixes they post
  a new `@sandy` comment once; commits in between do not start reviews.
- Base-Branch Exclusion (ADR 0016) is retired: its only job was to gate the
  automatic `gh pr ready` arming, which no longer exists. The `excludeBranches`
  key in `.config/bot.yaml` is now inert — left in the schema for compatibility,
  scheduled for removal in a separate cleanup. The matcher module and its event
  wiring are deleted.
- Historical trigger values (`push`, `ready`, `opened`, `rerun`) remain valid on
  ReviewJob rows already in Convex; the `ReviewTrigger` union is left wide rather
  than migrating stored data. New jobs carry only `mention`.
- "Reactive" is dropped from Sandy's pitch. The trade-off is explicit: no
  surprise reviews, at the cost of remembering to ask.
