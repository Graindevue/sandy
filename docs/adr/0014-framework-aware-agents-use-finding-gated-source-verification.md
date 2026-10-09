# 14. Framework-aware Agents use finding-gated source verification

Date: 2026-06-01

Status: Accepted

> **Amendment (2026-10-09).** Verify runtime claims against the exact installed
> version's implementation, reading local source first and using `opensrc` when
> needed. Version-matched bundled official docs guide targeted source reads;
> pin fetched source explicitly and resolve dependencies from their owning
> workspace. The [agent guidance audit](../research/2026-10-09-agent-guidance-audit.md)
> records current official guidance and the latest-version fallback risk.

## Context

Sandy's framework-aware Agents review libraries that change faster than model
training cycles: Next.js, Convex, React, i18n libraries, auth SDKs, and similar
dependencies. ADR 0008 established `opensrc` as the way Agents read
installed-version dependency source, but the shipped Agent prompts still risked
staleness by organizing guidance as named feature checklists.

Those examples were doing two jobs:

- Feature enumeration: which framework features exist and should be checked.
- Failure-mode priming: reviewer knowledge about ways a feature can go wrong.

Feature enumeration dates quickly. Failure-mode priming is still valuable,
especially before the phase-3 learning loop has enough promoted Rules.

Phase 3 also introduces a bridge problem: learned Rules in `.bot/rules.md` and
`.bot/product-rules.md` may duplicate or conflict with shipped seed examples.
The prompt needs a clear precedence model so seeds and Rules do not fight.

## Decision

Framework-aware Agent prompts are method-first. They describe how to reason about
the diff, installed framework version, config, manifest, and call sites before
listing any examples.

Concrete examples remain, but only as explicitly non-exhaustive seed knowledge.
They are cold-start priors, not the spec. Active Product Rules and Repo-local
Rules are version-controlled instructions for the Review. If an active Rule
conflicts with a seed example, the Rule wins. If a Rule and a seed example point
at the same issue, the Agent emits at most one Finding with the strongest
concrete evidence.

Agents that have `opensrc` in their tool allowlist receive a shared source
verification contract in the generated review prompt:

- Do not fetch dependency source preemptively.
- Before emitting a Finding whose correctness depends on framework or library
  behavior, verify that behavior against the installed version's source with
  `opensrc`.
- Record the package, installed version when available, source path or symbol,
  and confirmed behavior in the existing free-text `evidence` field.
- Treat training memory and type-shape guesses as insufficient evidence for
  framework-behavior claims.
- Suppress Findings that cannot be verified to the required confidence.

Framework-agnostic Agents keep their existing lists, but state that their
examples are non-exhaustive and require concrete evidence.

## Consequences

- Clean PRs do not pay the cost of dependency-source reads.
- Framework-behavior Findings pay the verification cost exactly when they would
  otherwise become user-visible assertions.
- Agents are less anchored to stale feature lists, reducing both false positives
  against new framework versions and false negatives for features not named in a
  shipped prompt.
- The phase-3 learning loop can add Rules without requiring seed examples to be
  retired. Identical lines are already deduplicated when Product Rules are
  merged; semantic duplicates are handled by the Agent emitting one Finding and
  by Synthesizer dedupe.
- Verification metadata stays in `evidence` for now, avoiding Finding schema
  churn before phase 3 proves it needs structured fields.

## When to revisit

Reconsider if `evidence` is too unstructured for SuggestedRule inference, if
`opensrc` verification cost becomes material, or if Agents suppress too many
useful Findings because installed-version source is hard to navigate.
