# 19. Local Reviews run on the developer's machine

Date: 2026-10-25

Status: Accepted

PR Reviews under [0017](./0017-manual-only-review-triggering.md) and
[0018](./0018-github-actions-codex-runtime.md) are unchanged.

## Context

Developers want Sandy's Findings before they open a pull request. Sandy has no
hosted review service. PR Reviews run on GitHub Actions only from new `@sandy`
comments, are serialized around one CI auth stream whose refresh token rotates,
and record their state in Convex.

## Decision

`sandy review` runs a Local Review in the developer's own process, using the
ReviewExecutor, Agents, prompts, and Synthesizer of a PR Review.

- **Scope.** It reviews the committed diff from the merge base of the base ref
  to `HEAD`. The base ref is `--branch`, else `origin/HEAD`, `origin/main`, or
  `origin/master`. Uncommitted work produces a warning and is not reviewed.
  Nothing is fetched for the reviewed Repo. The Action's 5,000 changed-line
  limit declines larger diffs. `--instructions` adds a requester focus to every
  Agent prompt; it cannot override the review contracts.
- **No shared state.** No ReviewJob is created, nothing is posted to GitHub,
  and nothing is written to Convex. The result goes to stdout and is saved
  under the CLI home (`~/.sandy/cli`), which keeps the newest 50 Local Reviews.
- **Its own login.** `sandy login` signs a dedicated Codex home
  (`~/.sandy/cli/codex`) in with the file credential store. The CLI refuses
  `~/.codex`, and never reads or copies `CODEX_AUTH_JSON` or a CI login, so the
  CI auth stream keeps a single owner. A lock on each CLI home serializes the
  Reviews and sign-ins that share its login.
- **Isolated workspace.** The head commit is pushed into a fresh bare mirror
  whose base ref points at the merge base, so commits the base gained later
  cannot read as changes the branch reverts. Agents work in a detached worktree
  of the mirror. Other branches, stashes, unreachable objects, hooks, and the
  checkout's Git config never reach an Agent. The Codex sandbox also denies the developer's checkouts, saved Local
  Reviews, operator config, other Sandy state, and common credential stores in
  the home directory, including `~/Library` on macOS.
- **Serial Agents.** Each Agent runs one `codex exec` with targeted tests. The
  managed runtime and `parallel` mode are not used.
- **Configuration.** `--config` or `SANDY_CONFIG_PATH` comes first. The Sandy
  checkout's `.config/bot.yaml` is used next when it lists the Repo. Otherwise
  the CLI uses the single-Repo defaults the GitHub Action generates. Sibling
  Repos of a multi-repo Product are cloned from origin's host with the
  developer's Git credentials, at their default branches as in CI.

## Considered options

- **A hosted run.** A dispatched Actions run would need the branch pushed,
  would restore a request path that ADR 0017 retired, and would queue behind PR
  Reviews on the CI auth stream.
- **The developer's `~/.codex` login.** Interactive sessions would share
  writable auth with Reviews, and Agents could read personal Codex state.
- **Reviewing the checkout, or a linked worktree of it.** Agents would see
  uncommitted work, stashes, and every branch, and a linked worktree writes into
  the checkout's Git directory.

## Consequences

- A Local Review lasts only as long as its process. It cannot be resumed or
  polled from another shell, and an interrupted Review is not saved.
- Local Reviews spend the dedicated login's ChatGPT plan quota.
- On macOS, Codex's sandbox can read every path it does not deny, and it has
  network access. A hostile branch could use install scripts, tests, or prompt
  injection to read other files and send them out, so review only trusted
  branches. On Linux, reads are limited to system, temporary, and tool
  directories, and the worktrees.
- Local Review output contains private code and Findings, and it stays on the
  developer's machine.
