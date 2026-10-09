# Phase 3 — Learning Loop Active

> **Historical plan (May–June 2026).** Preserved as the original implementation record, including its original status and unchecked criteria. Current execution is GitHub Actions with serial Codex Agent Runs; containers, host services, reactive workers, and learning provisioning below are retired. See [ADR 0018](../adr/0018-github-actions-codex-runtime.md) and the [current setup guide](../setup/README.md).


Status: Draft
Owner: Tony
Target: 👍 / 👎 reactions tune the bot. Suppressions reduce noise; SuggestedRules drive Rule promotion.

## Goal

Activate the continuous-learning pipeline. Findings cluster into Archetypes via embeddings. Reactions on bot comments feed back into Archetype `suppressionWeight`. Repeated negative signal generates SuggestedRules awaiting manual promotion via the Convex Dashboard. Promotion either opens a PR (positive Rules) or flips an Archetype weight (suppressions).

## What ships

### New / extended Convex tables

```typescript
archetypes: {
  productId,
  agentKey,               // clusters are scoped to one reviewer persona
  label,                  // human-readable, generated from exemplars
  exemplarEmbedding,      // 768-dim worker-supplied nomic-embed-text Finding embedding
  exampleFindingIds,      // up to N=5 references
  count,
  suppressionWeight,      // 0.0 → 1.0; ≥0.7 = dropped by Synthesizer
}

findings: { ...phase2, archetypeId, embedding }

reactions: {
  findingId,
  kind: '👍' | '👎' | 'mergedFixed' | 'mergedIgnored',
  replyText?,             // free-text reply if any
  createdAt,
}

suggestedRules: {
  productId,
  type: 'positive' | 'suppression',
  status: 'suggested' | 'promoteToPositive' | 'promoteToSuppression' | 'rejected' | 'promoted',
  description,            // LLM-generated draft
  sourceArchetypeId,
  evidence,               // serialized list of supporting Finding/Reaction IDs
  createdAt,
}
```

### Code

**`packages/convex-backend/`** (extended)
- `archetypes.ts` — mutation: `assignOrCreateArchetype(findingId, embedding)`; query: `byProduct`; mutation: `updateSuppressionWeight`; clusters are scoped by `(productId, agentKey)`.
- `reactions.ts` — mutation: `recordReaction`; subscription-friendly query: `recentByArchetype`.
- `suggestedRules.ts` — mutation: `createIfEvidenceThresholdMet`; query: `subscribePending`; mutation: `markPromoted`.
- `crons.ts` extended:
  - Finding embeddings are 768-dimensional and worker-supplied; Convex does not embed server-side.
  - `inferSuggestedRulesFromReactions` daily — looks for Archetypes with ≥3 negative reactions and no existing SuggestedRule; drafts one.
  - `rollupMergeStateSignals` daily — checks merged PRs for "merge-with-fix" vs "merge-without-fix" implicit signal per Finding.

**`packages/bot-worker/`** (extended)
- `src/learning/embed.ts` — `embedFindingText(text)` via local Ollama `nomic-embed-text`.
- `src/learning/archetype-assigner.ts` — runs after each Agent emits Findings; embeds the Finding's `evidence` (not its summary — surface-variable summaries scatter identical issues below the threshold) and calls `assignOrCreateArchetype`.
- `src/learning/reaction-handler.ts` — webhook handler for `pull_request_review_comment` reactions. Parses the HTML trailer to map back to the Finding; records the reaction.
- `src/learning/reply-handler.ts` — for replies under bot comments: stores `replyText` on the reaction record. The drafting step (Convex cron) uses this to seed SuggestedRule description.
- `src/learning/merge-state-inferrer.ts` — for merged PRs, walks the commits between Sandy's comment-post and the merge; if any commit touched the commented `file:line range`, that's `mergedFixed`; otherwise `mergedIgnored`.
- `src/learning/promotion-worker.ts` — reactive subscription to `suggestedRules` with `status` in `promoteToPositive | promoteToSuppression`. On change:
  - `promoteToPositive` → fetches the Archetype's exemplars, calls a small LLM (Haiku) to draft a Rule line, opens a PR to `.bot/product-rules.md` in the most-affected Repo, marks SuggestedRule `promoted`.
  - `promoteToSuppression` → calls Convex to set Archetype's `suppressionWeight = 1.0`, marks SuggestedRule `promoted`.
- `src/synthesizer/suppression-filter.ts` — drops Findings whose Archetype has `suppressionWeight ≥ 0.7` before posting.

### Operator workflow (no new UI — uses Convex Dashboard)

1. Operator opens Convex Dashboard → `suggestedRules` table.
2. Reviews `description`, `evidence`.
3. Edits row: `status` ← `promoteToPositive` / `promoteToSuppression` / `rejected`.
4. Worker's reactive subscription fires within seconds; takes the corresponding action.
5. For positive promotion, the auto-opened PR appears on GitHub; operator merges to activate the Rule.

## Out of scope

- Pre-prompt suppression (including suppressed Archetypes in Agent system prompt) → considered for Phase 4 if data shows post-filter is wasteful.
- CLI for the operator workflow → Phase 4 or later if Dashboard becomes painful.
- MCP server → not planned (see ADR 0005).

## Acceptance criteria

- [ ] Every posted bot comment carries the HTML trailer `<!-- bot:finding=... archetype=... -->`.
- [ ] A 👎 reaction on a comment lands a `reactions` row referencing the correct Finding.
- [ ] Two semantically similar Findings on different PRs end up in the same Archetype.
- [ ] After ≥3 👎 reactions on the same Archetype with reply text, a `suggestedRules` row appears with a drafted description.
- [ ] Editing a `suggestedRule` to `promoteToSuppression` causes the Archetype's `suppressionWeight` to be set to `1.0` within a few seconds; subsequent Reviews don't post Findings of that Archetype.
- [ ] Editing a `suggestedRule` to `promoteToPositive` causes a PR to appear in the targeted Repo, modifying `.bot/product-rules.md`.
- [ ] Sandy reviews its own promotion PRs (meta-validation — catches obvious rule drafting mistakes).
- [ ] A merged PR where the commented file:line was modified between comment and merge results in a `mergedFixed` reaction record.

## Dependencies

- Phase 2 must be merged.
- Local Ollama server with `nomic-embed-text` available.
- Anthropic API key for Haiku (Rule drafting).

## Open questions

- Embedding cost at scale? At ~$0.02 / 1M tokens, ~5000 Findings/year = trivial. Verify.
- Threshold for SuggestedRule creation: 3 negative reactions feels right; calibrate after observing real signal.
- How to handle conflicting reactions on the same Archetype (some 👍, some 👎)? Recommend `suppressionWeight` = negative / total ratio, not absolute count.
- Should `mergedIgnored` count as 👎 signal? Recommend yes, but at 1/3 weight (the spec called this out).

## Sequencing within Phase 3

1. Convex schema additions + functions.
2. `embed.ts` + `archetype-assigner.ts` (Findings get clustered).
3. `reaction-handler.ts` + comment trailer end-to-end check.
4. `suggested-rule` inference cron + drafting.
5. `promotion-worker.ts` + the two promotion paths.
6. `suppression-filter.ts` in Synthesizer.
7. `merge-state-inferrer.ts` (lowest priority — gives passive signal).
