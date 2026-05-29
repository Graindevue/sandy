# TASK

Drive the automated PR review gate for PR `{{PR_URL}}` on branch `{{BRANCH}}`
to a clean state.

# GOAL

Get the PR to a state with:

- Zero unresolved **actionable** automated-review comments
- Passing required status checks

Sandy uses **CodeRabbit** as its automated PR reviewer (see `AGENTS.md`).

# PROCESS

You can lean on the `check-pr` skill, which categorizes PR review comments and
status checks. The loop:

1. Ensure you are on branch `{{BRANCH}}`.
2. Push any local commits.
3. CodeRabbit reviews automatically on push. If no review appears, request one by
   commenting `@coderabbitai review` on the PR.
4. Wait for CodeRabbit and CI to finish (`gh pr checks {{PR_URL}}`).
5. Read CodeRabbit's summary and inline comments (`gh pr view {{PR_URL}}`, plus
   the review-comments API).
6. Fix all actionable comments.
7. Resolve addressed threads (reply and resolve).
8. Commit (Conventional Commits, no AI footers) and push.
9. Repeat until there are zero unresolved actionable comments and checks pass, or
   the max iteration limit is reached.

# RULES

- Fix only actionable feedback. Do not make unrelated changes.
- Preserve intended functionality unless fixing a real bug.
- If a comment is informational or a false positive, explain why and resolve it
  if appropriate.
- When framework behaviour matters and local types/docs/errors do not fully
  answer the question, follow @.sandcastle/OPENSRC.md.
- Run relevant tests/type checks (`pnpm type-check`, `pnpm test`, `pnpm lint`)
  before committing.

# OUTPUT

If the gate is clean, output:

```text
<review-gate>clean</review-gate>
```

If the gate cannot reach a clean state, output:

```text
<review-gate>blocked</review-gate>
<remaining>
- file:line — remaining issue
</remaining>
```
