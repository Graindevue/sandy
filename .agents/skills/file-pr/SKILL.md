---
name: file-pr
description: File a concise pull request following Sandy conventions. Use when the user asks to file, open, or create a PR.
---

# File PR

Identify the target GitHub repository from the user's request and Git remotes.
Use explicit `--repo <owner/name>` arguments when multiple remotes exist;
`origin` may point to a different fork or historical repository. Before filing,
check whether a PR for this branch already exists
(`gh pr list --repo <owner/name> --head <branch>`). Update that PR when it covers
the same work.

## Base branch

Feature work branches from `main` with a `phase-N/<slug>` name and targets
`main`. Follow [AGENTS.md](../../../AGENTS.md). Fetch the target repository's
base branch and review the diff against its current remote-tracking ref to make
sure the contents match the user's goal. Use another base only when the user
explicitly requests it.

## Pre-flight

- Review the full diff, including new files, and stage only the task's changes.
- Pass `pnpm lint`, `pnpm type-check`, and `pnpm test` before filing or updating
  the PR. Reuse checks already completed for the same changes; rerun affected
  checks after further edits.
- Report the requested behavior actually verified. For build or runtime
  changes, include the affected package build or runtime verification. Passing
  tests or a review score do not replace that evidence.
- Backend edits: regenerate Convex types before checks using the procedure in
  [packages/convex-backend/README.md](../../../packages/convex-backend/README.md),
  and include generated changes with their source changes.
- Runtime, auth, or trigger edits: read
  [ADR 0018](../../../docs/adr/0018-github-actions-codex-runtime.md) and
  [the setup guide](../../../docs/setup/README.md).
- For visual changes, capture matching before/after screenshots and prepare
  them as PR assets before filing. Keep screenshots out of the commit.
- File the PR from the main session so its URL can be registered with the
  user's thread.

## Title

PR titles usually become squash-commit messages. Use Sandy's Conventional
Commit style: the subject starts with `feat:` or `fix:`. Prefer a concise,
human-readable summary that explains why the change matters.

BAD

> fix: update agent prompt strings and configuration table

GOOD

> fix: prevent review findings based on outdated framework assumptions

## Description

Open with the concrete problem from the user's request, then briefly explain
the resulting behavior. Scale detail to the change; avoid leading with an
implementation inventory.

BAD

> Added a shared prompt constant, changed seven Markdown files, and expanded
> the effort table.

GOOD

> Reviewers could flag valid framework code using outdated assumptions. They
> now verify the exact dependency version and require a concrete failure path.

Include relevant validation and material limitations. For backend schema
changes, describe the data-model and migration impact. For visual changes,
include labeled before/after screenshots of matching states and affected
responsive variants, without sensitive data; explain when there is no
meaningful before or visible change. Commit messages and PR bodies have no AI
co-author or generated-by footers.

When using `gh`, write multiline descriptions to a temporary file and pass
`--body-file` to preserve the exact text.

## After filing

Open as a draft (`gh pr create --draft --base main`) unless the user explicitly
asks for a ready PR. A maintainer reviews the PR before merge.

When T3 Code exposes `link_pull_request`, register the full PR URL immediately
after creation or when starting work on an existing PR. Before finishing, use
`list_thread_pull_requests` and register any missing PR from this work.

If Greptile review is part of the requested workflow, request it with a fresh
`@greptile` comment. For an existing PR, wait for a running review to finish
before requesting the new head, and follow the user's retriggering instructions.
Keep the PR in draft until the requested review gate is satisfied; for a
Greptile 5/5 gate, mark it ready with `gh pr ready` after that score is reached.
If the user also asks to watch the PR, continue with
[babysit-pr](../babysit-pr/SKILL.md), which owns triggering and monitoring.
