# ISSUES

Here are the open issues in the repo labeled `ready-for-agent`:

<issues-json>

!`gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

# OPEN PRS (work already in flight)

Here are open PRs and the issues they close (parsed from `Closes #N` / `Fixes #N` / `Resolves #N` in the PR body — GitHub's native auto-linking is skipped because PRs target `staging`, not the default branch):

<open-prs-json>

!`gh pr list --state open --json number,title,body --jq '[.[] | {number, title, closes: [(.body // "" | scan("(?i)(?:closes|fixes|resolves) #([0-9]+)"))[] | tonumber]}]'`

</open-prs-json>

# ALL OPEN ISSUE NUMBERS (for blocker resolution)

A full list of open issue numbers regardless of label, used to tell whether a cited blocker is genuinely closed/merged vs. just absent from the label-filtered `<issues-json>` above (e.g. an open prerequisite a human is still working on without the `ready-for-agent` label):

<all-open-issue-numbers-json>

!`gh issue list --state open --limit 500 --json number --jq '[.[].number]'`

</all-open-issue-numbers-json>

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish
- B's body explicitly lists A under a `## Blocked by` section

A's status (open without PR / **in flight with open PR** / merged) does NOT change whether it is a blocker. Only a **merged** PR removes the dependency.

An issue is **in flight** if any entry in `<open-prs-json>` closes it. **In-flight issues MUST NOT be picked up again** — Sandcastle would spawn a parallel branch and duplicate the work. They still count as blockers for their dependents.

An issue is **unblocked** if BOTH conditions hold:

1. It is NOT in flight (no open PR closes it)
2. Every issue listed under its `## Blocked by` section (or otherwise identified as a blocker) is either (a) closed via a merged PR, OR (b) absent from `<all-open-issue-numbers-json>` (genuinely merged / closed — not merely missing the `ready-for-agent` label). A blocker that still appears in `<all-open-issue-numbers-json>` but is missing from `<issues-json>` is **still open** (likely a human's in-progress prerequisite without the `ready-for-agent` label) and continues to block its dependents.

For each unblocked issue, assign a branch name using the format `sandcastle/issue-{id}-{slug}`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42-fix-auth-bug"}]}
</plan>

Include ONLY unblocked issues. If every issue is in flight or blocked, output an empty array — the outer loop will then exit gracefully and wait for human merges:

<plan>
{"issues": []}
</plan>

Do NOT fall back to "highest priority blocked candidate" — that produces duplicate work on issues that already have an open PR.
