# 17. Reviews are manual-only — pushes never auto-trigger

Date: 2026-06-11

Status: Accepted

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

Reviews are **manual-only**. A Review is triggered by exactly two human actions:

1. An `@bot review` mention on the PR.
2. The **Re-run** control on Sandy's Review Status Check.

Every other webhook event is a no-op for triggering: `push`, `synchronize`,
`ready_for_review` (draft → ready), and PR open/reopen no longer start a Review.
PR close still clears the opt-in flag.

`reviewActive` is retained as **opt-in state only** — a record that a PR has been
put under Sandy review (set by the two triggers, cleared on close). It no longer
gates anything; nothing reads it to decide whether to enqueue.

Both manual triggers use the superseding enqueue path, so Cancel-on-Supersede
keeps working without push events: a fresh `@bot review` (e.g. after a fix push)
or a Re-run marks any in-flight Review for the PR as superseded and reuses or
enqueues the current-head job. A double `@bot review` dedupes to one job rather
than double-posting.

## Consequences

- The author controls review cadence. After pushing a batch of fixes they run
  `@bot review` once; commits in between cost nothing.
- Base-Branch Exclusion (ADR 0016) is retired: its only job was to gate the
  automatic `gh pr ready` arming, which no longer exists. The `excludeBranches`
  key in `.config/bot.yaml` is now inert — left in the schema for compatibility,
  scheduled for removal in a separate cleanup. The matcher module and its dispatch
  wiring are deleted.
- Stale historical trigger values (`push`, `ready`, `opened`) remain valid on
  ReviewJob rows already in Convex; the `ReviewTrigger` union is left wide rather
  than migrating stored data. New jobs only ever carry `mention` or `rerun`.
- "Reactive" is dropped from Sandy's pitch. The trade-off is explicit: no
  surprise reviews, at the cost of remembering to ask.
