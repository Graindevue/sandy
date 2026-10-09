# Setting up Sandy on GitHub Actions

Sandy executes finite reviews on GitHub-hosted Linux runners. Durable state lives
in Convex Cloud, and GitHub Actions serializes requests from new `@sandy` PR
comments.
[ADR 0018](../adr/0018-github-actions-codex-runtime.md) records the runtime.
The canonical Sandy source is the private `Graindevue/sandy` repository.

## Requirements

- A private caller repository with GitHub Actions and environments available.
- Admin access to the caller repository and the Sandy repository.
- A GitHub App installed on every Product Repo, including the caller.
- A Convex Cloud deployment with Sandy's current schema and functions.
- A ChatGPT plan including Codex and a separate CI login.
- Node 24, pnpm 10, Codex CLI, and authenticated `gh` for local setup.

## Setup order

| Step | Guide | Result |
|------|-------|--------|
| 1 | [Convex](./convex.md) | Deploy the backend and obtain its URL. |
| 2 | [GitHub App](./github-app.md) | Configure the review identity and auth write-back permissions. |
| 3 | [Product config](./bot-yaml.md) | Declare trusted Repos and Codex Agent selections. |
| 4 | [GitHub Actions](./github-actions.md) | Configure secrets, the dedicated login, and the caller workflow. |

The helper at [scripts/setup-actions.sh](../../scripts/setup-actions.sh) guides
the human-only login, permission, and checkout-token steps after the environment
and ordinary repository secrets exist. See its `--help` output for its options.

Once the caller workflow is on the default branch, a human collaborator with
repository write access posts a new comment containing standalone `@sandy` on an
open same-repository PR. This is the sole review trigger; no command suffix is
required. The summary prominently names the reviewed commit. After pushing more
commits, post a new `@sandy` comment to request another review.

## Authentication rules

`CODEX_AUTH_JSON` is stored in the **`sandy-codex` environment**. It is never
a repository secret: an environment reads the current auth only when a queued
job starts, after the prior Review has persisted its refreshed file.

One auth stream has one Actions concurrency group on the review job and serial
Agent Runs.
Give each independently operated caller its own dedicated login. For reseeding,
pause new review requests and ensure the active job has finished before replacing
the environment secret.

## Current limitations

Reviews use Codex CLI; configure selected personas with `vendor: codex`.
Embeddings, new Archetype assignment, reaction collection, and SuggestedRule
promotion are disabled. Historical learning data remains in Convex. The old
host-service setup is preserved only in historical ADRs and PRDs.
