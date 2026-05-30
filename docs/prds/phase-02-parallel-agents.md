# Phase 2 — Parallel Specialized Agents

Status: Draft
Owner: Tony
Target: Specialized agent fan-out with cross-repo product context.

## Goal

Activate Sandy's main value proposition: parallel framework-aware Agents that share a Product-wide context (the API Surface Manifest), each emitting category-specific Findings that the Synthesizer consolidates into one high-signal comment set. Ready Sandy for the addition of a second Repo within a Product.

## What ships

### New packages / packages extended

**`packages/manifest-builder/`** (new)
- `src/main.ts` — `buildManifest(productId, repoShas[])` → `{ markdown, structured }`.
- `src/extractor-registry.ts` — loads default Extractors from `extractors/*.ts`; overlays `.config/extractors/*.ts` via dynamic import.
- `src/aggregator.ts` — runs each registered Extractor against each Repo's worktree in parallel; merges the per-Repo sections into one markdown document.
- Default Extractors implemented:
  - `framework-versions.ts` — reads `package.json` + lockfile, returns version map.
  - `npm-exports.ts` — `ts-morph`-based extraction of `packages/*/src/index.ts`-style entry points.
  - `convex-api.ts` — Convex queries/mutations/actions with signatures.
  - `convex-schema.ts` — table/field/index extraction from `convex/schema.ts`.
  - `http-routes.ts` — Next.js `route.ts` + Convex HTTP actions.
  - `i18n-keys.ts` — scans `messages/`, `locales/`, `i18n/` for declared keys.

**`packages/bot-worker/`** (extended)
- `src/worker/fanout.ts` — replaces Phase 1's single-Agent invocation with `Promise.allSettled` over N enabled Agents, each in its own Apple Container.
- `src/worker/agent-selector.ts` — decides which Agents to run for this Review based on:
  - `defaultEnabled` field in Agent definition (`true` / `false` / `auto`)
  - Auto-detection: `auto` means "enable if the Repo's package.json declares the framework dependency"
  - Per-Repo `.bot/agents.yaml` overrides
- `src/synthesizer/` (new directory)
  - `dedup.ts` — clusters Findings within and across Agents by `(path, line proximity, summary cosine similarity)`. Drops duplicates, prefers higher-severity / higher-confidence version.
  - `score.ts` — computes the PR-level confidence score (0-5) from `(count × severity × confidence)` of open Findings + change blast radius.
  - `summary.ts` — generates the top-level PR summary comment template.
- `src/config/bot-config-reader.ts` — reads `.bot/rules.md`, `.bot/product-rules.md`, `.bot/agents.yaml`, `.bot/ignore.gitignore` from each Repo in the Product; merges product-rules across all Repos.

**`packages/convex-backend/`** (extended)
- `apiSurfaceManifests` table added — write-only audit log: `{ productId, repoShas, markdown, builtAt }`.
- `findings` table extended with `category`, `agentName`.
- `reviewJobs` table extended with `confidenceScore`, `agentRuns: Id[]`.

### Agents activated

All shipped Agents wired into fan-out:
- `logic.md`, `security.md`, `style.md`, `test-coverage.md` — framework-agnostic, run on every Review (style off by default).
- `convex.md`, `nextjs.md`, `i18n.md` — auto-enable based on `package.json` detection.

### Configuration

`.config/bot.yaml` schema extended:
```yaml
products:
  - id: my-product
    repos:
      - tcosentino/repo-a
      - tcosentino/repo-b
    agents:
      enable: [logic, security, convex, nextjs]
      vendors:
        logic: { vendor: codex, model: gpt-5.5 }
        security: { vendor: claude, model: opus }
```

Per-Repo `.bot/` reading enabled:
- `.bot/rules.md` — Repo-local Rules
- `.bot/product-rules.md` — Product-shared Rules (merged from all Repos)
- `.bot/agents.yaml` — per-Repo Agent enable / disable / config overrides
- `.bot/ignore.gitignore` — files Sandy ignores when reading the diff

## Out of scope

- Embedding clustering of Findings into Archetypes → Phase 3
- Reaction handling → Phase 3
- SuggestedRules → Phase 3
- `@bot focus <agent>` commands → Phase 4

## Acceptance criteria

- [ ] A Product with two Repos (`repo-a`, `repo-b`) is registered. A PR in `repo-a` triggers a Review whose system context includes the Manifest covering both Repos.
- [ ] An Agent in the `repo-a` Review correctly identifies a cross-repo issue (e.g., a Convex query rename in `repo-a` breaks a consumer in `repo-b`).
- [ ] Multiple Agents run in parallel — wall time approximates the slowest Agent, not the sum.
- [ ] One Agent crashing (Apple Container exit non-zero) does not block other Agents from posting their findings.
- [ ] Duplicate findings across Agents (e.g., logic + security both flag the same untrusted input) are collapsed by the Synthesizer.
- [ ] PR summary comment shows the confidence score (0-5).
- [ ] Per-Repo `.bot/rules.md` is included in that Repo's Agent prompts but not in another Repo's.
- [ ] `.bot/product-rules.md` from each Repo is unioned and present in every Agent prompt across the Product.
- [ ] The `convex.md` Agent does not run if no Repo in the Product has a `convex` dependency.

## Dependencies

- Phase 1 must be merged and stable.
- `ts-morph` for Extractor implementations.
- `tree-sitter` (and any specific grammar deps) for `tree_sitter_query` Agent tool.

## Open questions

- Should the manifest persistence (`apiSurfaceManifests` table) cap at the last N manifests per Product? Recommend N=20.
- What's the dedup cosine threshold for Findings? Start at 0.85 (same as Archetype clustering in Phase 3); tune from real data.
- Per-Agent timeout for Apple Container execution? Recommend 5 minutes hard cap; force kill + record `agentRuns.status = 'timed_out'`.

## Sequencing within Phase 2

1. Manifest builder + the 6 default Extractors (independent work).
2. `agent-selector` + `fanout` in the worker (depends on Manifest available).
3. Synthesizer (depends on multi-Agent output).
4. `.bot/` reader (independent of Synthesizer).
5. End-to-end test with the second Repo added.
