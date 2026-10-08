# Connecting a private repository to Sandy

The caller workflow lives in the reviewed repository. It checks out a trusted
Sandy commit and invokes [.github/actions/review/action.yml](../../.github/actions/review/action.yml).
The canonical source is private `Graindevue/sandy`; source checkout uses
explicit read access rather than the caller's automatic token.

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

The template's global `sandy-codex-session` concurrency group serializes Reviews
with queueing and `cancel-in-progress: false`. Its review job selects the
`sandy-codex` environment so the current auth is read after the lock is acquired.
Agent Runs are also serial. Keep those settings together.

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

## 4. Choose Product configuration

Without `SANDY_CONFIG_PATH`, the action creates one Product for the caller Repo
and selects `logic` at `xhigh`, `security` at `high`, and `convex` at
`high` only for Convex changes. When dependency installation succeeds and a
test script exists, Sandy runs the project test suite once and includes its
result in the review. Optional repository variables:

| Variable | Purpose |
|----------|---------|
| `SANDY_PRODUCT_SLUG` | Stable Product identity; defaults to repository name. |
| `SANDY_PRODUCT_NAME` | Product display name. |
| `SANDY_MODEL` | Codex model for generated config; default `gpt-5.5`. |
| `SANDY_CONFIG_PATH` | Trusted `bot.yaml` path relative to `GITHUB_WORKSPACE`. |

For multiple Repos or custom selection, commit a non-secret
`.github/sandy/bot.yaml` on the caller's default branch and set:

```bash
gh variable set SANDY_CONFIG_PATH --repo Graindevue/graindevue --body repository/.github/sandy/bot.yaml
```

The `repository/` prefix matches the caller checkout path in the template.
See [bot-yaml.md](./bot-yaml.md) for the schema.

## 5. Verify a review

Dispatch with an open PR number after the workflow is merged:

```bash
gh workflow run sandy-review.yml --repo Graindevue/graindevue --field pr=123
gh run list --repo Graindevue/graindevue --workflow sandy-review.yml --limit 5
```

Verify Findings/the summary and the advisory **Sandy** Check Run on the PR, a
completed ReviewJob and Agent Runs in Convex, and successful auth persistence.
Inspect the summary's test status: a confidence score of 5/5 or successful
Actions run does not prove tests ran. An otherwise successful review receives
a neutral Sandy Check Run when tests are unavailable, failed, or skipped.
The review can still complete with static analysis.
You can subsequently request reviews with `@sandy review` or
`@agent-sandy review`. The Check Run's Re-run event is best-effort because GitHub
can suppress Actions-origin check events; use a mention or dispatch if no run
starts.

Pushes, PR open, and draft-to-ready transitions do not review automatically.
Monitor your ChatGPT plan quota and Actions minutes separately.

## Recovery

If auth refresh fails, wait for the active review to end, then create a fresh
dedicated login and replace the **environment** secret. If auth persistence
failed, repair the permission or secret-store problem before requesting another
Review. Do not restore an earlier repository-secret or artifact copy of auth.
