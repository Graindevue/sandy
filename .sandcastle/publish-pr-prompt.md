# TASK

Publish branch `{{BRANCH}}` as a GitHub pull request targeting `{{TARGET_BRANCH}}` for issue `{{TASK_ID}}: {{ISSUE_TITLE}}`.

# PROCESS

1. Ensure you are on branch `{{BRANCH}}`.
2. Push the branch to `origin`.
3. Create a draft PR targeting `{{TARGET_BRANCH}}` if one does not already exist.
4. If a PR already exists for this branch, reuse it and verify its base is `{{TARGET_BRANCH}}`.

Repository policy: PRs must target `{{TARGET_BRANCH}}`. Never target `main`.

# PR DETAILS

Title:

```text
{{TASK_ID}}: {{ISSUE_TITLE}}
```

Body should include:

```md
Sandcastle implementation for `{{TASK_ID}}`.

Branch: `{{BRANCH}}`
Base: `{{TARGET_BRANCH}}`

Closes #{{TASK_ID}}
```

The `Closes #` keyword makes GitHub auto-close the issue when the PR is merged.

# OUTPUT

Output exactly one PR URL inside a `<pr_url>` tag:

```text
<pr_url>https://github.com/owner/repo/pull/123</pr_url>
```
