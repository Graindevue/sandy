---
name: coderabbit-review
description: Request and verify CodeRabbit reviews on Sandy GitHub pull requests. Use when setting up PR review, checking the CodeRabbit gate, or replacing a Greptile review workflow on Sandy.
---

# CodeRabbit Review

Sandy uses CodeRabbit's free open-source PR reviews. Repository configuration
lives in `.coderabbit.yaml`; CodeRabbit reads it from the PR's head branch.
Follow [AGENTS.md](../../../AGENTS.md) for branching and maintainer review.
Use explicit `--repo Graindevue/sandy` arguments because `origin` may be a fork.
Register PRs with T3 Code's `link_pull_request` when available.

## Request a review

Read the PR's current head SHA, draft state, checks, bot comments, and reviews.
Public repositories with fewer than 10 stars require manual requests; enabling
automatic review in YAML does not remove that requirement. Request reviews
explicitly, including after pushes, while this restriction applies.

- First review, skipped review, or a requested fresh pass over the entire PR:
  `gh pr comment <number> --repo Graindevue/sandy --body '@coderabbitai full review'`.
- Subsequent changes after a completed review:
  `gh pr comment <number> --repo Graindevue/sandy --body '@coderabbitai review'`.

Check for an automatic review already running or completed on the current head
before posting. Wait for an in-flight review to finish before requesting the new
head. Request at most once per head unless the user explicitly asks for another
pass. Manual requests also work on draft PRs.

## Verify completion

Poll at intervals of at most 60 seconds and keep the user informed. Inspect all
of these sources, paginating API results:

- `gh pr view <number> --repo Graindevue/sandy --json headRefOid,statusCheckRollup,reviews`
- `gh api --paginate repos/Graindevue/sandy/issues/<number>/comments`
- `gh api --paginate repos/Graindevue/sandy/pulls/<number>/reviews`
- `gh api --paginate repos/Graindevue/sandy/pulls/<number>/comments`
- GraphQL `reviewThreads` with `isResolved`, `isOutdated`, and comment authors.

CodeRabbit may report through commit statuses rather than check runs and may
edit its existing walkthrough comment. Read current comment bodies and both
status types. A green status accompanied by **Review skipped**, an acknowledgement
such as **Full review triggered**, or a summary alone is not a completed review.
Match a submitted review's `commit_id` or the walkthrough's reviewed commit range
to the current `headRefOid`; timestamps alone do not prove coverage.

Inspect `coderabbitai[bot]` reviews, inline threads, and walkthrough details,
including actionable findings outside the diff and additional comments. Verify
whether older unresolved findings still apply to the current source.

If no review starts within 10 minutes, or a started review has not completed
within 20 minutes, report the last observed state and stop waiting. On a rate
limit or file-limit message, report the stated limit and retry time; wait within
these bounds when possible. `@coderabbitai rate limit` can inspect capacity.
Keep this workflow within free OSS access; paid usage is a separate user choice.

## Review gate and fixes

CodeRabbit has no Greptile-style 5/5 confidence gate. The gate is a completed
review of the current head, no remaining actionable CodeRabbit findings, and
passing required CI. With `request_changes_workflow` enabled, also verify the
bot's current review decision. Maintainer review remains required before merge.
Skipped, failed, pending, rate-limited, or partially covered reviews leave the
gate incomplete.

When the user requests fixes or ongoing monitoring, continue with
[babysit-pr](../babysit-pr/SKILL.md). Verify findings against source before fixing
them. Let the next review resolve addressed threads; when a reply or manual
resolution is authorized, explain the evidence before resolving a false positive.
The top-level `@coderabbitai approve` and `@coderabbitai resolve` commands can
override review requirements; use a fresh review to establish the gate instead.

## Official references

- [Plans and OSS limits](https://docs.coderabbit.ai/management/plans)
- [Review commands](https://docs.coderabbit.ai/reference/review-commands)
- [YAML configuration](https://docs.coderabbit.ai/getting-started/yaml-configuration)
- [Request changes workflow](https://docs.coderabbit.ai/pr-reviews/request-changes-workflow)

Recheck these references when troubleshooting provider behavior or limits.
