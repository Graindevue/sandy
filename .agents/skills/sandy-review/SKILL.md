---
name: sandy-review
description: Run a Sandy Local Review of the current branch's commits and summarize its Findings. Use when the user wants Sandy's review of local work, such as before opening a pull request.
---

# Sandy Local Review

`sandy review` runs Sandy's reviewers on this machine against the committed diff
from the branch's merge base to `HEAD`, and posts nothing. `sandy --help` lists
every option; Sandy's `docs/setup/local-cli.md` covers installation.

## Run

1. **Preflight.** `sandy login status` exits 0 when the review login is signed
   in. When `sandy` is missing, point the user to the setup guide and stop. When
   it is signed out, ask the user to run `sandy login --device-auth` in their
   own terminal. That login comes only from `sandy login`; leave `~/.codex` and
   CI secrets untouched.
2. **Commits.** Only commits are reviewed. When `git status --porcelain` lists
   work the user expects reviewed, ask whether to commit it first.
3. **Review.** Run `sandy review --json` as a background task with a timeout of
   at least 60 minutes, and wait for it to exit: each reviewer may run for 10
   minutes, and stopping the process discards the Review. Add `--branch <base>`
   when the branch targets something other than origin's default branch, and
   `--instructions '<focus>'` when the user names a focus.
4. **Result.** The JSON object on stdout is the result; `[sandy]` lines on
   stderr are progress and warnings. Read the JSON from the command output; the
   CLI already saves it under `~/.sandy/cli`, and
   `sandy review show <id> --json` reprints it.

## Exit status

| Exit | Status | Next |
|------|--------|------|
| 0 | `completed` or `no_changes` | Summarize, or report that there are no commits to review |
| 1 | `incomplete`, `declined`, or `failed` | Report `status`, `error`, and each failed `agents[].error`; `declined` means the diff exceeds the changed-line limit. With no JSON on stdout, relay the `sandy:` message on stderr |
| 2 | Invalid input or setup | Relay the `sandy:` message on stderr; it names the fix |
| 130, 143 | Interrupted | Nothing was saved; rerun on request |

## Summary

Lead with `status`, `confidenceScore` (0–5, where 5 is clean; `null` unless
completed), and the Finding count per severity: `P0` critical, `P1` high, `P2`
medium. Then list every Finding, most severe first, as `path:lineStart` with its
`summary`, one sentence of `evidence`, and any `suggestedFix` as an unverified
direction. Name `repo` when it differs from `repository`, and cite
`crossRepoReferences`. Report `warnings`, such as uncommitted changes left out
of the Review. Findings are advisory: offer to fix the ones the user picks, then
commit and run a new Local Review on request.
