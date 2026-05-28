# 2. Products, not Repos, as the unit of cross-cutting context

Date: 2026-05-28

Status: Accepted

## Context

Sandy is designed for users who maintain related repositories — a backend monorepo and a separate desktop app, for example. Cross-repo concerns (API contracts, shared package types, business invariants) need to be reasoned about, or the bot misses entire classes of bugs: a backend rename that breaks consumers in another repo, a schema change that violates a frontend assumption, etc.

A naive design treats each repo independently. A graph-based design joins them via embeddings and symbol references (heavy infrastructure — see ADR 0001).

## Decision

Sandy introduces a "Product" as the unit of cross-repo reasoning. A Product is declared in `.config/bot.yaml` as a named group of Repos. All Agents reviewing any Repo in a Product have read access to all other Repos in that Product. The `ApiSurfaceManifest` is built across every Repo in the Product, not just the one being reviewed.

Products are the unit where:

- Cross-repo `ApiSurfaceManifest` aggregation happens
- Cross-repo Rules apply (`.bot/product-rules.md` files in any Repo of the Product are unioned at Review time)
- Learning-loop Archetypes are scoped (an Archetype clustered for Product A is irrelevant to Product B)

A Repo belongs to exactly one Product. There is no concept of a Repo shared between Products in v1.

## Consequences

- **Cross-repo bugs are catchable** without a code graph — Agents can `read_file` and `rg` across all Product Repos.
- **Adding a Repo to a Product is a `bot.yaml` edit + git clone** on the host. Onboarding a new Repo takes <5 minutes.
- **Per-Product configuration is explicit** — no inferring which repos belong together from naming conventions or remote URLs.
- **Repos not in any registered Product are not reviewed.** Intentional: explicit registration prevents accidental review of unrelated repos whose webhooks happen to fire.
- **Memory of cross-app contracts** is preserved per Product (not per Repo), matching how developers think about their products.

## When to revisit

If a Repo legitimately spans multiple Products (e.g., a shared utility library used by two unrelated products), the v1 "exactly one Product" rule needs revisiting. For now, register such a library under the Product whose Review quality benefits most.
