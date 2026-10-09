# 12. Cross-repo Findings post on the reviewed PR, anchored in-diff, with consumers as permalinks — never on the sibling Repo

Date: 2026-05-30

Status: Accepted

> **Runtime amendment (2026-10-09).** The anchor/reference and noise-control model remains. ADR 0018 retires the custom `tree_sitter_query` executable; Agents confirm structural usages using available source and runtime tools instead. Container mount paths below describe the original implementation.

## Context

A cross-repo break spans two Repos: the change is in the PR Repo (e.g. backend PR #42's rename), but the affected code is in a sibling at `main` (e.g. `desktop/src/orders.ts:42`). The sibling has no open PR in this Review.

GitHub imposes a hard constraint: a PR *review comment* can only attach to a file and line present in **that PR's own diff**. Phase 1's poster (`poster.ts`) builds review comments from `finding.location.path` against the PR Repo at the head SHA and ignores any notion of a foreign Repo — so a Finding located in desktop would attach a `desktop/...` path to the backend PR's diff, be rejected by the API, and be silently swallowed by the surrounding `catch`. Cross-repo Findings could not post at all.

Options for where a cross-repo Finding lands:

- **A) Anchor inline on the producer line in the reviewed PR; cite sibling consumers as permalinks in the body.**
- **B) Open an issue or comment on the sibling Repo** where the affected code lives.
- **C) Drop all cross-repo Findings into the PR's top-level summary comment only**, never inline.

## Decision

A cross-repo Finding posts on **the reviewed PR**, anchored to an **in-diff line**, with sibling consumers rendered as permalinks (A); summary-comment fallback (C) when no clean anchor exists. Never post to the sibling Repo (reject B).

This requires splitting the Finding location model:

- **`anchor`** `{ repo, path, lineStart, lineEnd }` — where the inline comment attaches. Must be in the reviewed PR's diff. For a cross-repo Finding this is the **in-diff line of whichever Repo holds the PR**: the producer-side change that caused the break (producer PR), or the new use of an absent symbol (consumer PR — naturally in-diff, no fallback needed).
- **`crossRepoReferences`** `{ repo, path, line }[]` — affected siblings at the recorded sibling `main` SHA (ADR 0010). Rendered in the comment body as GitHub permalinks pinned to that SHA, never as separate inline comments. The Agent emits the repo `fullName` (from the `/workspace/<owner>/<name>` mount mapping), which the poster joins with the recorded SHA to build the permalink. The poster routes by `anchor.repo == PR repo`.

When a cross-repo Finding has **no postable anchor** (e.g. the break comes from deleting a file, or a diffuse semantic change), it folds into the PR's summary comment (C) with the references rendered as text.

Noise control travels with this model: **one Finding per changed contract item** (carrying its consumers as `crossRepoReferences`), never one Finding per reference; references must be **confirmed real usages** (resolved import / call site / key lookup, with tree-sitter structural confirmation for symbols too generic to grep safely — no coincidental string matches); the rendered list is capped (~10, "+ N more in `<repo>`") while the **true count drives severity** so a large blast radius escalates one prominent Finding rather than flooding the PR.

## Consequences

- **The cause is in-diff; the effect is out-of-diff.** Anchoring on the producer/consumer change puts the warning where the developer acts; the sibling references become evidence (permalinks), not separate comments.
- **One conversation, one PR.** Matches Sandy's "post where PR conversations already happen." Posting to the sibling (B) would split the conversation, double notifications, and target a Repo with no open PR thread.
- **Permalinks are stable** because they pin the recorded sibling `main` SHA, not a moving branch ref — they keep pointing at the line the Review actually judged.
- **The Finding schema gains an `anchor`/`crossRepoReferences` split**, and the poster gains anchor-repo routing and permalink construction (Phase 2 work; Phase 1's single-location poster is a strict subset — a same-Repo Finding is just an anchor with no references).
- **Findings with no anchor degrade gracefully** to the summary comment rather than failing to post.

## When to revisit

Reconsider posting to the sibling Repo (B) only if Sandy ever reviews coordinated PRs across siblings in one Review and a genuine cross-PR thread becomes the natural home for the discussion.
