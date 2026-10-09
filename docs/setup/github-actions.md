# Connecting a private repository to Sandy

The caller workflow lives in the reviewed repository. It checks out a trusted
Sandy commit and invokes [.github/actions/review/action.yml](../../.github/actions/review/action.yml).
The canonical source is `Graindevue/sandy`. Private source deployments require
explicit read access rather than the caller's automatic token. The supplied
production template retains this explicit source-access path.

## 1. Prepare access and the environment

Configure the App using [github-app.md](./github-app.md) and deploy Convex using
[convex.md](./convex.md). The App must have **Environments: read & write** on
the caller installation.

Create a GitHub environment named `sandy-codex`. It should allow the trusted
default branch used by the workflow. For the existing Graindevue deployment:

```bash
gh api --method PUT repos/Graindevue/graindevue/environments/sandy-codex
```

Set these **repository secrets** on the caller:

| Secret | Value |
|--------|-------|
| `SANDY_APP_ID` | GitHub App ID. |
| `SANDY_APP_PRIVATE_KEY` | Full PEM private key. |
| `CONVEX_URL` | Sandy's deployed Convex URL. |
| `SANDY_SOURCE_TOKEN` | Optional PAT override with read-only Contents access to private `Graindevue/sandy`. |
| `SANDY_SOURCE_SSH_KEY` | Optional private key for a read-only deploy key on the source repository, where organization policy allows deploy keys. |

Prefer selecting `Graindevue/sandy` in the existing Graindevue `agent-sandy`
installation as well as the Product Repos. The caller then mints a separate
Contents-read installation token for the selected Sandy source Repo. The
reviewed repository's automatic token cannot check out another private Repo,
even within the same organization.

Alternatively, provide a fine-grained PAT scoped to Sandy under the `Graindevue`
resource owner as `SANDY_SOURCE_TOKEN`, or a read-only source deploy key as
`SANDY_SOURCE_SSH_KEY` where permitted. Either skips source App-token creation.
Use `gh secret set` with a prompt or stdin, rather than putting token values in
shell command history. The action verifies checkout credential cleanup before
reviewed scripts run. The setup helper supports installation and PAT paths and
recognizes an already provisioned SSH secret.

## 2. Create a dedicated CI Codex login

Use a fresh directory for this login. The
[setup helper](../../scripts/setup-actions.sh) walks through the process:

```bash
bash scripts/setup-actions.sh --repo Graindevue/graindevue --source Graindevue/sandy
```

To perform just the login and auth upload manually:

```bash
SANDY_CI_CODEX_HOME="$PWD/.config/ci-codex"
mkdir -p "$SANDY_CI_CODEX_HOME"
chmod 700 "$SANDY_CI_CODEX_HOME"
printf '%s\n' 'cli_auth_credentials_store = "file"' > "$SANDY_CI_CODEX_HOME/config.toml"
chmod 600 "$SANDY_CI_CODEX_HOME/config.toml"
CODEX_HOME="$SANDY_CI_CODEX_HOME" codex login --device-auth
gh secret set CODEX_AUTH_JSON --repo Graindevue/graindevue --env sandy-codex < "$SANDY_CI_CODEX_HOME/auth.json"
```

Enable device-code login in the ChatGPT account settings if prompted. This login
is independent from interactive `~/.codex` credentials. After upload, CI owns
this session exclusively; do not run local Codex against that same directory.

The action uses file-backed ChatGPT auth, allows Codex's built-in refresh, and
writes the latest file back to the environment after a run. See
[OpenAI's CI/CD auth procedure](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
A repository-secret copy is unsafe because queued jobs capture stale auth.
Every caller needs an independent login unless a single shared queue owns its
entire auth stream.

## 3. Pin Sandy and install the caller workflow

Set `SANDY_REF` to the full 40-character SHA of the Sandy commit you reviewed.
That commit must contain the composite action and be accessible to the source
token:

```bash
gh variable set SANDY_REF --repo Graindevue/graindevue --body "$(git rev-parse HEAD)"
gh variable set SANDY_SOURCE_REPOSITORY --repo Graindevue/graindevue --body Graindevue/sandy
```

Copy [.github/workflow-templates/sandy-review.yml](../../.github/workflow-templates/sandy-review.yml)
into the caller as `.github/workflows/sandy-review.yml`, and merge its PR.
The default branch supplies both the workflow and any trusted Product config.

The review job's `sandy-codex-session` concurrency group serializes Reviews
with queueing and `cancel-in-progress: false`. Its review job selects the
`sandy-codex` environment so the current auth is read after the lock is acquired.
Skipped jobs for unrelated events do not acquire this lock.
Keep that whole-job lock and environment together for every workflow using the
login. Agent execution defaults to serial. An explicitly enabled parallel
Review uses one managed app-server, so thread concurrency does not remove the
job-level authentication lock.

The action validates a human requester with repository write access, an open PR,
a private caller, and a same-repository PR head. Fork PRs are declined. Reviewed
package scripts run in a credential-free sandbox; review agents use a filesystem
profile that denies access to auth files, the App key, and other credential
directories. On Ubuntu, the action installs bubblewrap and its AppArmor profile
before materializing Codex auth so the native sandbox can create its isolated
user namespace. During dependency installation, Sandy skips only a root
`prepare` script whose exact command is `lefthook install`, in the isolated
reviewed worktree. It restores the original `package.json` bytes before tests
and review; other dependency lifecycle scripts still run.
Turbo's cache lives inside the reviewed worktree so linked-worktree cache sharing
does not write to the protected parent clone.
Linux uses explicit filesystem grants for required system tools, writable review
and temporary cache directories, and read-only shared Git metadata and sibling
source. Native caches must also satisfy ownership checks on their ancestor
directories, including those enforced by SWC.

The action optionally restores the reviewed repository's package downloads from
GitHub Actions cache, separately from the cache used to build Sandy. Every review
still performs a fresh frozen installation. Supported stores are npm's
`_cacache` and pnpm's content store, with side-effect and local-project records
excluded. Installed dependencies, source, test outputs, tool homes, logs,
credentials, and configuration files are never saved.

pnpm first fetches the frozen graph with scripts and pnpmfile hooks disabled.
Sandy snapshots those validated downloads before the normal installation runs
reviewed hooks and lifecycles. The publication snapshot is denied to reviewed
commands, and package imports use copies to keep installation writes out of it.
Only successful normal preparation publishes that snapshot. npm retains its
lockfile tarball integrity checks when reading cached content.

Download keys include the repository, operating system and architecture, Node
major version, exact reviewed package-manager pin, and a digest of the reviewed
lockfile, manifest, and install configuration. npm requires its installed CLI to
match the reviewed pin; pnpm retains the existing exact `npx` pin. Missing or
unverified keys, other stores, credential-bearing configuration, and unavailable
cache services retain ordinary installation. Restored stores are checked before
use, and a failed warm installation gets at most one cold retry within the
preparation budget. Cache workers have a 30-second operation limit and stop
before cleanup on cancellation. Only successful dependency preparation publishes
downloads; a genuine install failure retains static-analysis review.

The publication store uses a stable `sandy-dependency-downloads` directory beside
the dedicated Codex home. Reviewed commands have an install-only write grant for
the separate `sandy-dependency-downloads-install` store. Both are cleared after
each preparation. Keep the publication path stable across Actions runs because
the cache service includes the supplied paths in its cache version. Phase logs
distinguish cache restore and save, installation, and total preparation time; a hit label alone
does not prove fewer downloads.

Parallel Reviews prepare dependencies once and copy private source/installation
workspaces before starting the runtime. This complete inventory lets the
sandbox deny each peer explicitly while allowing native tools to resolve their
own directory ancestors. Each Agent owns its temporary files and writable
caches; the prepared seed, sibling sources and Git metadata are read-only.
Copy time and disk overhead count toward benchmark costs.

The action accepts `agent-execution-mode: serial|parallel` and
`max-agent-concurrency` (a positive integer; parallel default three, one selects
serial). Environment equivalents for the entry point are
`SANDY_REVIEW_EXECUTION_MODE` and `SANDY_REVIEW_AGENT_CONCURRENCY`. The effective
mode/cap appears in phase logs. An incompatible pinned runtime falls back before
any Agent starts; runtime failure during execution retains completed outcomes
and fails affected work rather than starting another investigation.

Keep the mode at `serial` until the
[runtime and quality gates](../benchmarks/review-speed.md) pass on your Linux
execution environment and dedicated login. Mock protocol tests cannot establish
live authentication rotation, finding recall or production latency.

## 4. Choose Product configuration

Without `SANDY_CONFIG_PATH`, the action creates one Product for the caller Repo
and selects `logic` and `security`, adding `convex` only for Convex changes.
All three use `gpt-6.1-sol` with `xhigh` effort by default. When dependency
installation succeeds, reviewers can run focused tests for concrete Findings.
Sandy leaves the full repository suite to CI by default, rather than blocking
every review on recursive builds and unrelated tests. The summary explicitly
reports this deferral. Optional repository variables:

| Variable | Purpose |
|----------|---------|
| `SANDY_PRODUCT_SLUG` | Stable Product identity; defaults to repository name. |
| `SANDY_PRODUCT_NAME` | Product display name. |
| `SANDY_MODEL` | Codex model for generated config; default `gpt-6.1-sol`. Effort is `xhigh` for all selected reviewers. |
| `SANDY_CONFIG_PATH` | Trusted `bot.yaml` path relative to `GITHUB_WORKSPACE`. |
| `SANDY_TEST_MODE` | `targeted` (default) leaves full-suite execution to CI; `suite` runs the root test script once before reviewers. |
| `SANDY_TEST_TIMEOUT_SECONDS` | Full-suite budget in `suite` mode: 1–600 seconds, default 120. |
| `SANDY_AGENT_EXECUTION_MODE` | `serial` (default) or `parallel`, gated by runtime/authentication and quality evidence. |
| `SANDY_AGENT_CONCURRENCY` | Positive maximum selected Agents in parallel mode; default three, one selects serial. |

The workflow template passes these test settings to the action's `test-mode`
and `test-timeout-seconds` inputs. Existing callers that omit them use focused
verification. Suite commands retain the reviewed repository's package-manager
pin and execute in the same credential-free sandbox as dependency installation.
Timed-out commands retain bounded startup and final diagnostics. Actions logs
show installation, optional suite execution, and reviewer start/end timings.

For multiple Repos or custom selection, commit a non-secret
`.github/sandy/bot.yaml` on the caller's default branch and set:

```bash
gh variable set SANDY_CONFIG_PATH --repo Graindevue/graindevue --body repository/.github/sandy/bot.yaml
```

The `repository/` prefix matches the caller checkout path in the template.
See [bot-yaml.md](./bot-yaml.md) for the schema.

## 5. Verify a review

After the workflow is on the default branch, a human collaborator with repository
write access requests a review on an open same-repository PR by creating a
comment containing standalone `@sandy`. The comment can consist of just the tag:

```bash
gh pr comment 123 --repo Graindevue/graindevue --body '@sandy'
gh run list --repo Graindevue/graindevue --workflow sandy-review.yml --limit 5
```

Verify Findings/the summary and the advisory **Sandy** Check Run on the PR, a
completed ReviewJob and Agent Runs in Convex, and successful auth persistence.
The summary prominently identifies the reviewed commit; verify it is the head
you intended to review. After new commits, create a new `@sandy` comment to
request another review.
Inspect the summary's test status: a confidence score of 5/5 or successful
Actions run does not prove tests ran. An otherwise successful review receives
a neutral Sandy Check Run when the full suite is deferred to CI, unavailable,
failed, or skipped. Focused reviewer tests do not imply that the whole suite passed.
The review can still complete with static analysis.

Only newly created comments trigger reviews. Editing a comment, clicking the
Check Run's Re-run control, rerunning an earlier Actions workflow, workflow
dispatch, pushes, and PR lifecycle changes do not start one. Only the initial
Actions attempt is accepted; request another review with a new `@sandy` comment.
The accepted mention is `@sandy`; `@agent-sandy` is not an alias.
Monitor your ChatGPT plan quota and Actions minutes separately.

## Recovery

If auth refresh fails, wait for the active review to end, then create a fresh
dedicated login and replace the **environment** secret. If auth persistence
failed, repair the permission or secret-store problem before requesting another
Review with a new `@sandy` comment. Rerunning the failed Actions workflow is
rejected. Do not restore an earlier repository-secret or artifact copy of auth.
