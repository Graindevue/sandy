# 11. Cross-repo breaks are judged against sibling `main`, framed as contract drift, with no in-flight-PR reconciliation

Date: 2026-05-30

Status: Accepted

## Context

Sibling Repos are mounted at their default-branch HEAD (ADR 0010). That fixes the *reality* a cross-repo Finding is judged against, and it raises a coordination problem.

Scenario: backend PR #42 renames `getActiveOrders` → `listActiveOrders`. Desktop's `main` still calls `getActiveOrders` in five places. The developer is doing a coordinated rollout — desktop PR #99 is already open and switches those five calls, intended to merge alongside #42. When Sandy reviews backend #42 and greps desktop `main`, it finds five references and can report "this rename breaks desktop." That is *true against `main`*, but the developer already has the fix in flight and may find the comment redundant.

The question: should Sandy try to be clever — enumerate open sibling PRs, detect that #99 already removes the references, and suppress the Finding?

Three options were considered:

- **A) Judge against sibling `main` only.** Honest and deterministic; fires on every coordinated rename even when an adaptation PR exists.
- **B) Reconcile in-flight sibling PRs.** Before flagging, scan open sibling PRs and suppress if one already removes the references.
- **C) Judge against `main` only, but frame the Finding as cross-repo contract drift** rather than a hard bug, so the developer dismisses it per-instance when coordinated.

## Decision

Sandy judges every cross-repo reference against sibling `main` only and does **not** reconcile in-flight sibling PRs (reject B). Such Findings carry **contract-drift framing**: a clearly-labeled "this change removes/uses a symbol that sibling@`main` references/lacks in N places (list)" rather than a P0 outage, with severity reflecting that it is true against deployed code.

The rule is **symmetric** (it generalizes across both directions of the PR):

- Producer-side PR (removes/renames a symbol siblings still use) → contract-drift Finding listing the affected consumers.
- Consumer-side PR (uses a symbol absent from a sibling's `main`, e.g. because the producing PR is still open) → contract-drift Finding noting the symbol is not present in sibling@`main`.

## Consequences

- **The contract is "I tell the truth about `main`."** A hard rename *does* break deployed siblings until they ship; surfacing that once, accurately, is the cross-repo value, not noise.
- **No undefined, combinatorial PR-matching.** "Which sibling PR is the adaptation?" has no reliable answer (zero, several, or a half-done one), Sandy cannot know deploy ordering, and a matching PR would not prove safety. B was rejected on these grounds, not on cost alone.
- **Framing, not suppression, handles coordinated rollouts.** We deliberately do **not** lean on the learning loop to train down "you renamed X, a consumer uses X" — that archetype is dangerous to suppress, because the next rename with *no* adaptation PR is a real outage that would now be silenced. The developer dismisses the coordinated case per-instance instead.
- **Redundant comments during coordinated renames are accepted** as the cost of never silencing a genuine break.

## When to revisit

Reconsider if coordinated multi-Repo rollouts become frequent enough that per-instance dismissal is a real friction — at which point a *narrow, explicit* opt-in (e.g. an `@bot` directive on the producer PR naming the adaptation PR) would be preferable to automatic, intent-guessing reconciliation.
