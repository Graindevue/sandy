# Reviewing a branch locally

`sandy review` runs Sandy's reviewers on your machine against the commits on
your branch, before you open a pull request. It uses the same Agents, prompts,
and Synthesizer as a PR Review. It posts nothing, and saves the result locally.
[ADR 0019](../adr/0019-local-branch-review-cli.md) records the design.

## Requirements

- Node 24 and pnpm 10, to build Sandy.
- The Codex CLI on `PATH`, or its path in `SANDY_CODEX_EXECUTABLE`.
- A ChatGPT plan that includes Codex, or an OpenAI API key.
- A checkout whose `origin` remote names the GitHub Repo. Otherwise, pass
  `--repo owner/name`.

## Install

From a Sandy checkout:

```bash
pnpm install
pnpm --filter @sandy/shared-types --filter @sandy/manifest-builder --filter @sandy/bot-worker build
```

Then add an alias to your shell profile, with the checkout's absolute path:

```bash
alias sandy='node /path/to/sandy/packages/bot-worker/dist/local-review/cli.js'
```

The CLI reads Agents from the checkout it was built in, so rebuild after you
pull.

## Sign in

Local Reviews use their own Codex login, kept in `~/.sandy/cli/codex`:

```bash
sandy login --device-auth
sandy login status
```

Plain `sandy login` signs in through the browser. `--with-api-key` and
`--with-access-token` read the secret from stdin, for example
`printenv OPENAI_API_KEY | sandy login --with-api-key`. To keep the login in
another dedicated directory, pass `--codex-home <dir>` or set
`SANDY_CODEX_HOME`. `sandy logout` signs it out.

The CLI refuses `~/.codex`. Keep the CI login on CI. Never copy
`CODEX_AUTH_JSON` from the `sandy-codex` environment to your machine. Each
Review rotates its refresh token, and a second user of that auth stream breaks
CI Reviews. [The Actions guide](./github-actions.md) explains the CI login.

## Review a branch

Commit your work, then run one of these from the checkout:

```bash
sandy review                     # plain text
sandy review --json              # one JSON object on stdout
sandy review --branch release    # diff against origin/release
sandy review --instructions 'Check the retry path.'
sandy review --fast              # Codex fast mode
```

`--branch` prefers `origin/<branch>`, then the ref as given, so a local branch
or a SHA also works. Without it, Sandy tries `origin/HEAD`, then `origin/main`,
then `origin/master`. Sandy never fetches
your branch's Repo, so run `git fetch` when the base may be stale. Only commits
are reviewed, and uncommitted changes produce a warning. A detached HEAD works.

Each reviewer takes several minutes, and the defaults run up to three, one
after another. Progress goes to stderr (`--quiet` hides it), and the result goes
to stdout. Press Ctrl-C once to stop and clean up, or twice to quit at once. An
interrupted Review is not saved.

| Exit | Status |
|------|--------|
| 0 | `completed`, or `no_changes` when there are no commits to review |
| 1 | `incomplete` (a reviewer failed, so the Review is unscored), `declined` (over the changed-line limit), or `failed`; an unexpected error prints only a `sandy:` message on stderr |
| 2 | Invalid input or setup, such as a missing login |
| 130, 143 | Interrupted by SIGINT or SIGTERM |

## Saved Reviews

```bash
sandy review list               # newest first
sandy review show               # the newest Review
sandy review show 20261025T10   # by id or unique id prefix
sandy review show --json
```

The newest 50 Reviews are kept as owner-only files in `~/.sandy/cli/reviews`,
or `$SANDY_CLI_HOME/reviews` when that is set.
A run with nothing to review is not saved.

`--json` prints, and `show --json` reprints, these fields:

- `id`, `status`, `repository`, and `branch` (`null` when HEAD is detached).
- `base` (`ref`, `sha`, `mergeBase`) and `head`.
- `changedLines`.
- `confidenceScore`: from 0 to 5, where 5 is clean. It is `null` unless the
  Review completed.
- `summary`, `findings`, `agents`, and `warnings`.
- `startedAt` and `finishedAt`, plus `error` when there is one.

Findings come most severe first. Each one has these fields:

- `id`, `severity` (`P0` critical, `P1` high, `P2` medium), and `confidence`
  (from 0 to 5).
- `category`, `agentKey`, `repo`, `path`, `lineStart`, and `lineEnd`.
- `summary` and `evidence`.
- When present: `suggestedFix`, `alsoReportedBy`, and `crossRepoReferences`.

## Configuration

The CLI chooses Product configuration in this order:

1. `--config <path>` or `SANDY_CONFIG_PATH`.
2. The Sandy checkout's `.config/bot.yaml`, when it lists the Repo.
3. The GitHub Action's defaults: `logic`, `security`, and conditional `convex`
   reviewers on `gpt-6.1-sol` at `xhigh` effort.

`--model` replaces every reviewer's model. In a multi-repo Product, sibling
Repos are cloned into `~/.sandy/cli/repos`, or `$SANDY_CLI_HOME/repos`, from
origin's host with your Git credentials. They are read at their default
branches.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SANDY_CLI_HOME` | `~/.sandy/cli` | Login, saved Reviews, and sibling clones |
| `SANDY_CODEX_HOME` | `$SANDY_CLI_HOME/codex` | The Codex login; `--codex-home` overrides it |
| `SANDY_CONFIG_PATH` | none | Product configuration; `--config` overrides it |
| `SANDY_CODEX_EXECUTABLE` | `codex` | The Codex CLI to run |
| `SANDY_REVIEW_MAX_CHANGED_LINES` | `5000` | Larger diffs are declined |
| `SANDY_REVIEW_HIDDEN_PATHS` | none | More absolute paths to hide from reviewers, separated by `:` |

Keep `SANDY_CLI_HOME` and the temporary directory outside every checkout;
reviewers cannot read checkouts. Reviewers can read the CLI home and the
parent of the Codex home, so the CLI refuses either one when it is or contains
your home directory or a hidden path below, such as `~/.config`.

## What reviewers can see

Reviewers work in a detached worktree of a private mirror. The mirror holds
only the head and base commits, so other branches, stashes, and the checkout's
Git config stay out. The Codex sandbox hides these paths from them:

- Your checkouts, saved Reviews, Sandy's `.config`, and other `~/.sandy` state.
- Credential stores in your home directory, such as `~/.ssh`, `~/.config`,
  `~/.aws`, `~/.npmrc`, `~/.gitconfig`, and `~/.claude`.
- `~/Library` on macOS.
- The paths in `SANDY_REVIEW_HIDDEN_PATHS`. Add any other tool's login there,
  for example `export SANDY_REVIEW_HIDDEN_PATHS="$HOME/.acme:$HOME/notes"`.

On macOS the sandbox can still read other files and reach the network. The
branch's install scripts and tests run inside it, so review only branches you
trust. On Linux, the sandbox reads only system, temporary, and tool
directories, and the worktrees.

## Use from a coding agent

The [sandy-review skill](../../.agents/skills/sandy-review/SKILL.md) tells an
agent to run a Review, read the JSON, and summarize the Findings. To use it in
other repositories, symlink its directory into your agent's skills directory.
For Claude Code, that is `~/.claude/skills/sandy-review`.
