# Configuring the Sandy GitHub App

The App supplies Sandy's review identity, reads Product Repos, posts Findings
and the advisory **Sandy** Check Run, and persists the rotating CI login.
Actions receives its own repository events, so Sandy needs no public webhook
endpoint or webhook secret.

## Register or update the App

Use [personal App settings](https://github.com/settings/apps) or the owning
organization's Developer settings. Set the homepage to the Sandy repository
and disable **Webhook → Active** for the retired local service.

The existing deployment uses `agent-sandy` (App ID `3909356`), installed on
Graindevue. If you change permissions, accept the update on the installation
before running a review.

| Repository permission | Access | Purpose |
|-----------------------|--------|---------|
| Pull requests | Read & write | Resolve the PR and post review comments. |
| Checks | Read & write | Create/update the advisory Sandy Check Run. |
| Contents | Read | Fetch the reviewed Repo and registered siblings. |
| Issues | Read | Read the PR conversation's review request. |
| Environments | Read & write | Read environment-secret metadata and persist refreshed `CODEX_AUTH_JSON`. |
| Metadata | Read | Required baseline repository information. |

An existing App may retain **Contents: write** from the historical Rule-promotion
workflow; current review execution requires read access. Repository
**Secrets: write** alone does not grant environment-secret write-back.
`GITHUB_TOKEN` does not supply this App permission.

App settings and permission acceptance are human steps; the
[setup helper](../../scripts/setup-actions.sh) provides their links. Other setup
and secret operations use `gh`.

## Private key and repository secrets

Generate a private key from the App settings. Keep the downloaded PEM outside
version control, for example at `.config/sandy-app.private-key.pem`. The App
key and ID are repository secrets on the caller:

```bash
gh secret set SANDY_APP_ID --repo Graindevue/graindevue --body 3909356
gh secret set SANDY_APP_PRIVATE_KEY --repo Graindevue/graindevue < .config/sandy-app.private-key.pem
```

The rotating Codex login goes into a separate environment secret, as described
in [github-actions.md](./github-actions.md).

## Installation scope

Install the App on every Repo declared in the Product config. For repositories
owned by another account, select that account's installation separately.

Checking out the canonical private `Graindevue/sandy` source from a Graindevue
workflow needs explicit access too. Add Sandy to the existing App installation's
selected repositories; the caller mints a separate Contents-read source token.
An optional `SANDY_SOURCE_TOKEN` fine-grained PAT can supply the same read access
instead. `SANDY_SOURCE_SSH_KEY` also supports a read-only source deploy key where
organization policy permits it. Installation tokens only grant access to
selected Repos; the caller's automatic token is limited to its own Repo.

## Verification

Run a manual review and verify the `sandy-codex` auth persistence step succeeds.
A permissions error before Codex runs usually means the Environments permission
update is absent or has not been accepted. Comments and the **Sandy** Check Run
should appear under the App's identity.
