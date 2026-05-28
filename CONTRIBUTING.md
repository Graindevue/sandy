# Contributing to Sandy

Sandy is built primarily for one developer's daily use, but the runtime is generic and contributions are welcome.

## Ground rules

- **No project-specific assumptions in core.** If a change references a specific product, application, or business domain, it belongs in `.config/`, not in the repository. Framework awareness is fine; project awareness is not.
- **Framework-aware ≠ project-specific.** A Convex-specific Agent prompt is in scope because Convex has many users. A "9-phase booking state machine validator" is out of scope — that belongs in someone's private `.config/agents/`.
- **Discuss architecture changes via ADRs.** See [`docs/adr/`](./docs/adr/) for the format. New cross-cutting concerns deserve an ADR before implementation.

## Code style

- **Biome** handles lint + format. Run `pnpm lint:fix` before committing.
- **Vitest** for tests. Run `pnpm test` locally.
- **TypeScript strict mode** is non-negotiable.

## Pull request workflow

Branches: `main` (default / production) ← `staging` (integration) ← feature branches.

1. Branch from `staging` (name it `phase-N/<slug>`)
2. Make focused changes; include tests where reasonable
3. Run `pnpm lint:fix && pnpm type-check && pnpm test`
4. Open a PR **against `staging`**, never directly against `main`
5. **CodeRabbit** reviews every PR automatically — address its actionable feedback before merge

`staging` is promoted to `main` via a separate release PR. Once Sandy is operational, it will review its own PRs too.

## What we won't merge

- Code that hard-codes paths, file names, or conventions specific to one project
- Dependencies on a specific cloud SaaS unless gated behind a configuration flag
- Tests using real-world product code (use synthetic fixtures)
- Removal of the HTML comment trailer (`<!-- bot:finding=... archetype=... -->`) — load-bearing for the learning loop

## Releasing

Maintainer-only. Sandy follows semver. Versions are tagged in git; no npm publishing currently.
