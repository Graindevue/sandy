# Sandy Domain Glossary

This document captures the vocabulary that shows up across the Sandy codebase. Stay precise about these terms; sloppy use leads to architectural drift.

## Product

A group of GitHub repositories that together form one logical software product. A Product is the unit at which Sandy reasons about cross-repo context. Configuration in `.config/bot.yaml` declares Products and the Repos they contain.

Example: a company with one backend monorepo and one desktop app repo registers both as a single Product. A Sandy Review of a desktop PR can read from the backend Repo, and vice versa.

Cross-repo access is physical, not summary-only: every other Repo in the Product is bind-mounted read-only into each Agent's sandbox alongside the PR worktree, so an Agent can `rg`/`read_file` the actual sibling code. The ApiSurfaceManifest is layered on top as a cheap index ("what exists, what version"), not as the sole source of cross-repo knowledge — see "ApiSurfaceManifest".

## Repo

A single GitHub repository. Belongs to exactly one Product. Sandy clones each Repo to local disk on the host machine and keeps it up to date via webhooks.

## Review

The act of running one or more Agents over a Pull Request. A Review produces a set of Findings. Reviews are triggered by webhook events: PR opened (only when configured), push to a PR with `reviewActive = true`, `@bot review` mention, or `gh pr ready` (draft → ready transition).

## ReviewJob

A queued unit of work in Convex. Status flows: `pending` → `running` → (`completed` | `failed` | `superseded`). One ReviewJob per Review attempt. Multiple ReviewJobs may exist for the same PR over time as iteration happens.

## Agent

A single reviewer persona — a system prompt + a vendor/model selection + a tool allowlist + a completion signal. Agents are markdown files in `agents/` (defaults shipped with Sandy) or `.config/agents/` (per-instance customizations). Multiple Agents run in parallel within a Review, each in its own Apple Container.

Agents are NOT software components — they are configuration data. Adding a new Agent does not require code changes to Sandy.

## Finding

A single issue raised by an Agent during a Review. Carries:

- `severity`: P0 (critical) / P1 (high) / P2 (medium)
- `confidence`: 0-5
- `anchor`: `{ repo, path, lineStart, lineEnd }` — where the inline comment attaches. Must be in the reviewed PR's diff (GitHub only accepts review comments on the PR's own changed lines). For a cross-repo Finding this is the **producer-side** line in the PR Repo that caused the break, not the consumer line.
- `crossRepoReferences`: optional `{ repo, path, line }[]` — affected consumers in sibling Repos (at the recorded sibling `main` SHA). Rendered in the comment body as GitHub permalinks, never as separate inline comments. When a Finding has no postable anchor (e.g. a deleted file), it folds into the summary comment with these references as text.
- `summary`: one sentence describing the issue
- `evidence`: supporting code excerpts or `rg` results
- `suggestedFix`: optional
- `category`: logic, security, convex, nextjs, i18n, style, test-coverage, etc.

Stored in Convex; persists across PRs for learning purposes.

## Archetype

A cluster of Findings that are semantically similar. Identified via embedding similarity (cosine > 0.85) on Finding summaries using `text-embedding-3-small`. Carries a `suppressionWeight` that the Synthesizer applies at posting time. Mutable state in Convex — not version-controlled.

## Rule

A human-authored guideline for what Agents should check or how they should behave. Lives in `.bot/rules.md` (Repo-local) or `.bot/product-rules.md` (Product-shared) inside each Product Repo. Version-controlled with the code the Rule applies to.

## SuggestedRule

A candidate Rule inferred by the learning loop from repeated 👎 reactions + replies, or from merge-without-fix patterns. Status flows: `suggested` → (`promoteToPositive` | `promoteToSuppression` | `rejected`) → `promoted`. Promotion is always manual — Sandy never auto-promotes a SuggestedRule into an active Rule (see ADR 0005 for rationale).

## ApiSurfaceManifest

A markdown document, built fresh per Review, describing the public API surfaces of every Repo in the Product. Includes: Convex queries/mutations/actions, Convex schema tables, npm-exported types, HTTP routes, i18n keys, framework versions resolved from `package.json` + lockfile. Built with the PR Repo at the PR head SHA and every sibling Repo at its default-branch HEAD. Used as cached system context for every Agent in a Review.

The Manifest is the **primary trigger** for cross-repo search, not the source of cross-repo knowledge: it never enumerates callers (see ADR 0001). When the PR diff changes/removes/adds a public-surface item the Manifest lists, the Agent is directed to `rg` the mounted sibling Repos for consumers of that symbol/contract. The Manifest answers "did this PR touch a contract, and what is the current surface/version"; the mounted siblings + `rg` answer "who actually depends on it."

See "Cross-Repo Search" for the full trigger contract, including the secondary diff-judgment trigger for behavioral changes the Extractors do not model.

## Cross-Repo Search

The act of an Agent grepping/reading the mounted sibling Repos (each at its default-branch HEAD — see "Product") to find consumers affected by a change in the PR Repo. Triggered two ways:

- **Primary (Manifest-driven):** the PR diff changes/removes/adds a public-surface item the ApiSurfaceManifest lists → search siblings for usages of that symbol/contract.
- **Secondary (diff-judgment):** the change is *likely* to affect another Repo's behavior or assumptions even when it is not in the Manifest — e.g. changes to external behavior, data shape/semantics, routes, events, config, auth, permissions, storage paths, generated artifacts, or shared conventions → targeted search anyway.

Cross-Repo Search does **not** run by default on every PR. CSS-only, test-only, or otherwise local-only changes skip it unless the diff suggests a cross-repo contract risk.

Auditability is load-bearing: whenever an Agent performs Cross-Repo Search it briefly states *why*; when it skips, it states that no cross-repo contract risk was detected. This keeps the headline feature debuggable and gives the learning loop a signal.

A cross-repo break is judged against sibling `main` only — Sandy does not reconcile in-flight sibling PRs (see ADR 0011). Such Findings carry contract-drift framing, and the rule is symmetric: it applies whether the PR is the producer (removed a symbol siblings use) or the consumer (used a symbol absent from a sibling's `main`).

Granularity and false-positive control: a changed contract item produces **one** Finding carrying its affected consumers as `crossRepoReferences`, never one Finding per reference. The Agent must confirm each reference is a real usage (resolved import / actual call site / actual key lookup — structural confirmation via tree-sitter for symbols too generic to grep safely), and must not report coincidental string matches; if it cannot confirm, it says so rather than emitting low-confidence noise. The rendered reference list is capped (~10, with "+ N more in `<repo>`"), but the true count drives severity — a large blast radius escalates one prominent Finding rather than flooding the PR. See ADR 0012.

## Extractor

Code that produces a section of the ApiSurfaceManifest from one Repo. Default Extractors ship with Sandy (`extractors/`); custom Extractors live in `.config/extractors/` and are loaded at startup via dynamic import.

## Synthesizer

The non-LLM post-processing step that runs after every Agent in a Review finishes. Responsibilities:

- Dedupe Findings (within and across Agents) by cosine similarity + location overlap
- Apply Archetype `suppressionWeight` to drop noise
- Sort by `severity × confidence`
- Format the final inline-comment set + summary comment
- Post via the GitHub App
- Persist Findings to Convex with their assigned Archetype IDs

## Reaction

A 👍 or 👎 emoji reaction (or a reply, or an inferred merge-state signal) attached to a Finding via the Comment Trailer. Captured by the GitHub webhook, recorded in Convex, fed into Archetype weighting and SuggestedRule inference.

## Comment Trailer

The HTML comment `<!-- bot:finding=<id> archetype=<id> -->` Sandy appends to every posted Finding. Lets the reaction webhook map back to records. Load-bearing — do not remove.

## Sticky Opt-In

The Review trigger model. PRs do not auto-review on open. The first `@bot review` mention or `gh pr ready` transition flips a `reviewActive` flag in Convex for that PR. Subsequent pushes to a `reviewActive` PR retrigger Reviews automatically. PR close clears the flag.

## Cancel-on-Supersede

When a new push lands during an in-flight Review, the running ReviewJob is marked `superseded`, its Apple Containers torn down, and a fresh ReviewJob queued for the new HEAD. Avoids reviewing stale SHAs.

## Sandcastle

The agent runtime layer, supplied by [`@ai-hero/sandcastle`](https://www.npmjs.com/package/@ai-hero/sandcastle) as an upstream dependency. Sandy uses Sandcastle to spawn Agents in Apple Containers and to dispatch across multiple LLM vendors (Claude, Codex, Cursor, Copilot). Sandy does not fork Sandcastle; see ADR 0003 for the trade-offs.

## opensrc

A CLI tool ([opensrc.run](https://opensrc.run)) that fetches actual source code for npm/PyPI/crates/GitHub dependencies. Installed inside every Apple Container so Agents can verify framework behavior against the real source for the installed version, bypassing LLM training-cutoff blind spots. See ADR 0008.
