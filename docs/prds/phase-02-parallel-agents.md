# Phase 2 — Parallel Specialized Agents

Status: Draft
Owner: Tony
Target: Specialized agent fan-out with cross-repo product context.

## Goal

Activate Sandy's main value proposition: parallel framework-aware Agents that share a Product-wide context (the API Surface Manifest), each emitting category-specific Findings that the Synthesizer consolidates into one high-signal comment set. Ready Sandy for the addition of a second Repo within a Product.

Cross-repo awareness is the headline feature, and it is **physical, not summary-only**: every sibling Repo is bind-mounted read-only into each Agent's sandbox so the Agent can `rg`/`read_file` real sibling code; the Manifest is the cheap trigger for when to do so. The mounting model (ADR 0010), how breaks are judged (ADR 0011), and where cross-repo Findings post (ADR 0012) are settled — this Phase builds them.

## What ships

### New packages / packages extended

**`packages/manifest-builder/`** (new)
- `src/main.ts` — `buildManifest(productId, repoShas[])` → `{ markdown, structured }`. `repoShas` carries the PR Repo at the PR head SHA and every sibling Repo at its default-branch HEAD SHA (ADR 0010/0011) — the same SHAs the worktrees are pinned to, so the Manifest and the mounted code always agree.
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
- `src/git/clone-manager.ts` (extended) — generalize worktree materialization beyond the PR Repo. Add a sibling path: for each other Repo in the Product, `fetch origin`, resolve its default branch to a SHA, and cut a **detached read-only worktree pinned to that SHA** (ADR 0010). The PR Repo keeps its existing PR-head worktree. All worktrees (PR + siblings) are torn down on Review completion via the existing `removeWorktree`.
- `src/worker/sandcastle-runner.ts` (extended) — mount every sibling worktree **read-only** at `/workspace/<owner>/<name>` alongside the PR worktree (which stays the Agent's `cwd`). Today it mounts only the opensrc cache + Codex auth; Phase 2 adds the sibling mounts and records each sibling's pinned SHA on the ReviewJob for later permalink construction.
- `src/worker/fanout.ts` — replaces Phase 1's single-Agent invocation with `Promise.allSettled` over N enabled Agents, each in its own Apple Container.
- Cross-Repo Search prompt contract (in `buildReviewPrompt` + Agent system prompts) — tell the Agent the `/workspace/<owner>/<name>` ↔ `owner/name` mapping, and instruct it to: (1) run Cross-Repo Search when the diff intersects the Manifest's public surface (primary trigger) or when the diff otherwise looks likely to affect a sibling's behavior/assumptions (secondary diff-judgment trigger — auth, routes, data shape, events, config, storage paths, generated artifacts, shared conventions); (2) skip it for local-only changes (CSS/tests) absent contract risk; (3) **confirm each hit is a real usage** (resolved import / call site / key lookup; tree-sitter structural confirmation for symbols too generic to grep safely) and never report coincidental string matches; (4) always state *why* it searched or that no cross-repo contract risk was detected (ADR 0010, CONTEXT.md "Cross-Repo Search").
- `src/worker/agent-selector.ts` — decides which Agents to run for this Review based on:
  - `defaultEnabled` field in Agent definition (`true` / `false` / `auto`)
  - Auto-detection: `auto` means "enable if the Repo's package.json declares the framework dependency"
  - Per-Repo `.bot/agents.yaml` enable / disable selection overrides
- `src/synthesizer/` (new directory)
  - `dedup.ts` — clusters Findings within and across Agents by `(path, line proximity, summary cosine similarity)`. Drops duplicates, prefers higher-severity / higher-confidence version.
  - `score.ts` — computes the PR-level confidence score (0-5) from `(count × severity × confidence)` of open Findings + change blast radius.
  - `summary.ts` — generates the top-level PR summary comment template.
- `src/config/bot-config-reader.ts` — reads `.bot/rules.md`, `.bot/product-rules.md`, `.bot/agents.yaml`, `.bot/ignore.gitignore` from each Repo in the Product; merges product-rules across all Repos.
- `src/worker/poster.ts` (extended) — route by `anchor.repo`: post the inline review comment against the **reviewed PR** at the `anchor` line (Phase 1 posts against `target.repo` and ignores the foreign-Repo case, silently dropping cross-repo Findings). Render `crossRepoReferences` as GitHub permalinks pinned to the recorded sibling SHA (never as separate inline comments). When a Finding has no postable `anchor`, fold it into the summary comment with references as text. Cap the rendered reference list (~10, "+ N more in `<repo>`"); never post to a sibling Repo (ADR 0012).

**`packages/shared-types/`** (extended)
- `src/finding.ts` — split the single `location` into `anchor` `{ repo, path, lineStart, lineEnd }` (where the inline comment attaches — must be in the reviewed PR's diff) and optional `crossRepoReferences` `{ repo, path, line }[]` (affected siblings at the recorded `main` SHA, rendered as permalinks). A same-Repo Finding is just an `anchor` with no references — Phase 1's single-location Finding is a strict subset (ADR 0012).

**`packages/convex-backend/`** (extended)
- `apiSurfaceManifests` table added — write-only audit log: `{ productId, repoShas, markdown, builtAt }`.
- `findings` table extended with `category`, `agentKey`, and the `anchor` / `crossRepoReferences` shape (replacing Phase 1's flat `location`).
- `reviewJobs` table extended with `confidenceScore`, `agentRuns: Id[]`, and `siblingShas` (the pinned default-branch SHA per sibling Repo, recorded at Review start for permalink construction).

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
      overrides:
        logic: { vendor: codex, model: gpt-5.5 }
        security: { vendor: claude, model: opus }
```

Per-Repo `.bot/` reading enabled:
- `.bot/rules.md` — Repo-local Rules
- `.bot/product-rules.md` — Product-shared Rules (merged from all Repos)
- `.bot/agents.yaml` — per-Repo Agent enable / disable selection overrides
- `.bot/ignore.gitignore` — files Sandy ignores when reading the diff

## Out of scope

- Embedding clustering of Findings into Archetypes → Phase 3
- Reaction handling → Phase 3
- SuggestedRules → Phase 3
- `@bot focus <agent>` commands → Phase 4

## Acceptance criteria

- [ ] A Product with two Repos (`repo-a`, `repo-b`) is registered. A PR in `repo-a` triggers a Review whose system context includes the Manifest covering both Repos, and `repo-b` is bind-mounted read-only at `/workspace/<owner>/repo-b`, pinned to its `main` SHA (recorded on the ReviewJob).
- [ ] An Agent in the `repo-a` Review correctly identifies a cross-repo issue (e.g., a Convex query rename in `repo-a` breaks a consumer in `repo-b`) **by grepping the mounted `repo-b`**, not from the Manifest alone.
- [ ] The cross-repo Finding posts on the **`repo-a` PR**, anchored to the producer line in the diff, with the `repo-b` consumer(s) rendered as permalinks pinned to `repo-b`'s recorded SHA. Nothing is posted to `repo-b`.
- [ ] The symmetric case works: a PR in `repo-b` that uses a symbol absent from `repo-a`@`main` produces a contract-drift Finding anchored on the `repo-b` diff line (ADR 0011).
- [ ] A local-only PR (CSS/test only) does **not** trigger Cross-Repo Search; the Agent states no cross-repo contract risk was detected.
- [ ] A rename with many consumers yields **one** Finding (not one per reference) with a capped reference list and severity reflecting the true count; coincidental string matches are not reported.
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
2. `clone-manager` sibling worktrees + `sandcastle-runner` read-only sibling mounts + record `siblingShas` (independent; unblocks all cross-repo behavior).
3. `shared-types` Finding `anchor`/`crossRepoReferences` split + Convex `findings`/`reviewJobs` schema migration (independent; unblocks the poster).
4. `agent-selector` + `fanout` in the worker (depends on Manifest available).
5. Cross-Repo Search prompt contract (depends on sibling mounts + Manifest).
6. Synthesizer (depends on multi-Agent output).
7. `poster` anchor-routing + permalinks (depends on the Finding split + recorded `siblingShas`).
8. `.bot/` reader (independent of Synthesizer).
9. End-to-end test with the second Repo added — exercise both directions and the local-only skip.
