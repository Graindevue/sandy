# 1. Agent-driven exploration, no persistent code graph

Date: 2026-05-28

Status: Accepted

## Context

Multi-tenant code-review SaaS products typically maintain a persistent, embedded graph of every codebase they review — files, symbols, callers, imports — stored in Postgres + pgvector and refreshed incrementally on push. This is substantial infrastructure: it must be built, kept warm, made fault-tolerant against missed webhooks, schema-migrated as the graph evolves, and tuned for retrieval quality.

The graph makes sense for a multi-tenant SaaS reviewing thousands of customer repositories. Sandy is single-user, reviewing a handful of repositories.

## Decision

Sandy does not build or maintain a persistent code graph. Agents navigate code on demand using tools (`read_file`, `rg`, `tree_sitter_query`, `git_diff`, `gh`, `opensrc`) the way Claude Code itself navigates conversations.

Cross-Repo Product context is provided via the `ApiSurfaceManifest` — a markdown summary built fresh per Review by parsing public API surfaces (Convex API, schema, npm exports, HTTP routes, i18n keys, framework versions). The Manifest is small (~20-30 KB for a graindevue-sized monorepo), built in seconds via tree-sitter + ts-morph, and passed as cached system context to every Agent in the Review.

## Consequences

- **No staleness class of bugs.** The Manifest matches the SHA being reviewed. There is no "indexer fell behind" failure mode to debug.
- **No persistent infrastructure for retrieval.** No Postgres, no pgvector, no incremental indexer, no graph schema migrations.
- **Cross-repo navigation works** via the Manifest + standard Agent tools, not via pre-built graphs.
- **Queries that benefit from precomputation** ("all callers of this function across the entire codebase") are not O(1) — Agents resolve them via `rg` at Review time. Acceptable at Sandy's scale; would not be at multi-tenant SaaS scale.
- **Indexing time disappears entirely.** Sandy has no initial index step.

## When to revisit

Reconsider if (a) Sandy is run on monorepos large enough that per-Review `rg` / tree-sitter scans become user-visibly slow (multiple seconds), or (b) a feature requires precomputed cross-repo graphs (e.g., a queryable MCP tool independent of any specific Review).
