# Sandy

Self-managed code review for private GitHub pull requests, with specialized
Codex reviewers and context from the repositories that form one Product.

Sandy runs on **GitHub Actions** (`ubuntu-latest`). Ask for a review with a PR
comment, the advisory **Sandy** Check Run's Re-run control, or a manual workflow
dispatch. Pushes and PR lifecycle events do not start reviews. Each run posts
inline Findings and a summary with a confidence score, and records its state and
token usage in Convex Cloud.

## How it works

```text
Manual GitHub Actions trigger
  → Check out Sandy and load trusted Product configuration
  → Create and claim a ReviewJob through the Convex HTTP client
  → Materialize the PR head and sibling default-branch worktrees
  → Build the Product API surface manifest and install review dependencies
  → Run the selected Codex personas serially against the diff and source
  → Dedupe and score Findings, post comments and an advisory Check Run
  → Persist refreshed Codex auth for the next review
```

Reviews and Agent Runs share a dedicated Codex login and are serialized to
preserve its rotating refresh token. Each Agent uses one `codex exec --json`
invocation, with at most one resume to finish the structured Findings response.
This uses ChatGPT plan quota; GitHub Actions compute remains a separate cost.

Cross-repo review reads actual sibling source pinned to each Repo's default
branch. The manifest identifies contracts worth searching; Findings cite
affected consumers with SHA-pinned permalinks and post on the reviewed PR.
Framework behavior is checked against installed-version source with `opensrc`
before it becomes a Finding.

## Current scope

- Multiple specialized personas, Product context, Repo-local Rules, dependency
  setup, Findings synthesis, GitHub posting, and durable review history.
- Manual review cadence and an advisory Check Run: Findings do not block merges.
- Codex CLI with a dedicated ChatGPT subscription login on private repositories.
- Embeddings, automatic Archetype assignment, reaction collection, and Rule
  promotion are disabled in this runtime. Historical learning data is retained.

The GitHub Actions runner replaces the local service, container runtime, and
AFK implementation harness. [ADR 0018](./docs/adr/0018-github-actions-codex-runtime.md)
records the migration. Earlier [PRDs](./docs/prds/) preserve their historical
scope; the [setup guide](./docs/setup/) describes current operation.

## Setup

You need a private GitHub repository with Actions enabled, a Convex Cloud
deployment, a GitHub App installed on the Product Repos, and a ChatGPT plan that
includes Codex. Local development uses Node 24 and pnpm 10.

Follow [docs/setup/README.md](./docs/setup/README.md) to configure the App,
deployment, trusted Product config, caller workflow, and dedicated CI login.
The login is separate from your interactive Codex credentials. Auth is stored
in the `sandy-codex` GitHub environment and written back after every run.

The canonical source is the private `Graindevue/sandy` repository. The caller
checks out an audited Sandy commit with explicit read access and invokes the
checked-out composite action at `.github/actions/review`. The original
`tony-co/sandy` repository retains its history. The caller workflow and setup
instructions explain the required access.

## Configuration and development

Default reviewer personas live in `agents/`; Extractors live in
`packages/manifest-builder/src/extractors/`. Instance overrides belong in the
gitignored `.config/` directory. In Actions, supply Product configuration from
the caller's trusted default branch rather than a PR head.

Read [CONTEXT.md](./CONTEXT.md) for vocabulary and [AGENTS.md](./AGENTS.md) for
contribution rules. Run `pnpm install`, `pnpm lint`, `pnpm type-check`, and
`pnpm test` before opening a PR against `staging`.

## License

MIT. See [LICENSE](./LICENSE).
