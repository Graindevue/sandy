# 7. Cross-repo Rules via per-repo `.bot/product-rules.md`

Date: 2026-05-28

Status: Accepted

## Context

A Product spans multiple Repos. Some Rules apply to one Repo only ("desktop should avoid synchronous IPC"). Others apply across the entire Product ("Convex schema changes must follow the widen-migrate-narrow pattern", "i18n keys added to `fr` must also be added to `en`").

Three options were evaluated:

- **A)** Per-repo `.bot/product-rules.md`, unioned across all Repos in the Product at Review time.
- **B)** Centralized product Rules on the host, separate from any Repo's code (e.g., in `.config/products/<id>/rules.md`).
- **C)** A designated "primary" Repo whose `.bot/` is the canonical home of product Rules.

## Decision

Cross-repo Rules live in `.bot/product-rules.md` inside each Repo. At Review time, Sandy collects `product-rules.md` from every Repo in the Product, merges them (deduplicating identical lines), and provides the result as cached system context to every Agent.

Repo-local Rules continue to live in `.bot/rules.md` and apply only to the containing Repo.

## Consequences

- **No "primary Repo" asymmetry.** Each Repo has equal standing to contribute Rules that apply across the Product. Adding a new Repo to the Product gives it equal authority.
- **Rules version-controlled alongside the code that enforces them.** A PR introducing a new pattern can simultaneously add the corresponding Rule.
- **Rule changes go through normal PR review.** Once Sandy is operational, Sandy reviews its own Rule additions — a useful sanity check.
- **Duplicate Rules possible** if multiple Repos define overlapping `product-rules.md` content. The merger treats identical lines as deduplicated; conflicting Rules need manual operator resolution.
- **No central source of truth for "what are the active product Rules right now?"** — the union must be computed. Sandy logs the merged Rule set at the start of each Review for auditability.
- **Cross-product Rule reuse requires copy/paste.** A Rule used by both Product A and Product B must exist in both. Acceptable at small scale; revisit if Product count grows.

## When to revisit

Reconsider centralizing on the host if (a) Rule conflicts between Repos become a frequent source of friction, (b) a Product gains so many Repos that the union becomes slow to compute (>1s wall time), or (c) cross-product Rule sharing becomes common enough that copy/paste is painful.
