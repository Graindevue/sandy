# Phase 4 — Polish

Status: Draft (will be re-scoped after Phase 1-3 lands)
Owner: Tony
Target: Sand off the rough edges that emerge from real daily use.

## Goal

Phase 4 is intentionally underspecified. It exists as a placeholder for ergonomic improvements that become obvious only after Phases 1-3 are in active use against real PRs. The specific items below are the highest-confidence candidates; the final scope will be revisited after a month or two of real usage.

## Candidate items

### "Fix in Claude Code" prompts

Append a copy-pasteable Claude Code prompt to each posted Finding. Includes:
- The Finding summary + severity
- The file path and line range
- The cross-repo context the Agent used (relevant Manifest excerpt)
- The Agent's suggested fix
- Markdown formatted so it can be pasted directly into Claude Code

Implementation: `src/synthesizer/cc-prompt.ts` formats the trailer block. Controlled by a config flag `fixWithAI: true` in `bot.yaml`.

### `@bot` command vocabulary

Mention parser in `src/webhook/dispatch.ts` recognizes:

- `@bot review` — already from Phase 1.
- `@bot ignore` — suppress this PR from auto-review until manually re-triggered. Sets `pullRequests.ignored = true`.
- `@bot focus <agent>` — single-Agent re-review (e.g., `@bot focus security`). Enqueues a ReviewJob limited to the named Agent.
- `@bot looprun` — kicks off a `/looprun` style iteration loop (review → fix prompt → wait for push → re-review → repeat until 5/5 confidence and zero unresolved comments). Lives partly in Sandy, partly in operator workflow. Bound by `MAX_LOOPRUN_ITERATIONS=10`.
- `@bot status` — Sandy replies with PR state: `reviewActive`, queue position, current Confidence Score, count of unresolved Findings.

### Pre-prompt suppression (hybrid v1 + v2)

If post-filter data shows the top-N most-suppressed Archetypes are being repeatedly flagged then dropped (wasted tokens), include them in the cached system prompt:

> Common false positives observed previously; do not re-raise unless context is materially different:
> - <archetype 1 label>
> - <archetype 2 label>
> ...

Triggered when an Archetype's `suppressionWeight ≥ 0.9` AND has been encountered in ≥5 Reviews.

### Operational improvements

The exact set depends on observed pain points. Likely candidates:

- A small CLI (`sandy <command>`) that wraps the most common Convex dashboard operations: `sandy rules suggested`, `sandy rules promote <id> --positive`, `sandy rules suppress <id>`, `sandy review <repo> <pr>`. Talks directly to Convex via the client SDK.
- Better failure observability — when an Agent crashes, the failure cause should surface in a summary comment ("security agent failed, other findings still posted").
- Health-check endpoint on the webhook server that Tailscale Funnel monitoring can hit.
- Log rotation for `~/Library/Logs/graindevue-bot/`.
- Cost dashboard via Convex query: tokens by vendor, by Agent, by Repo, by month.

### Quality-of-life

- Markdown formatting improvements in the summary comment (collapse "informational" findings under a `<details>` section by default).
- Configurable comment style (terse vs verbose) per Product.
- Re-roll button: a Sandy comment that, when reacted to with 🔄, re-runs the same Agent on the same Finding's context.

## Out of scope

- MCP server — explicitly deferred indefinitely (see ADR 0005).
- TREX-lite (auto test generation in a sandbox) — separate future PRD if pursued at all.
- Multi-operator support — Sandy assumes one operator (Tony).

## Acceptance criteria

To be defined when Phase 4 starts. Each candidate item above will be its own GitHub issue with its own acceptance criteria, prioritized based on real usage signal from Phases 1-3.

## Dependencies

Phase 3 must be merged. Real usage signal across 1-3 months recommended before locking the final Phase 4 scope.

## Sequencing within Phase 4

Driven by real pain. Likely first items:
1. `@bot status` (cheap, high-frequency value).
2. `@bot focus <agent>` (saves real cost on re-reviews).
3. Failure observability (a missed Agent run silently shipping is the worst failure mode).
4. CLI if Convex dashboard editing has become tedious by then.
5. Everything else.
