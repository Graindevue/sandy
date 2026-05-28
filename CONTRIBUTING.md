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

1. Fork the repository
2. Branch from `main`
3. Make focused changes; include tests where reasonable
4. Run `pnpm lint:fix && pnpm type-check && pnpm test`
5. Open a PR with a description of the change and its motivation

Once Sandy is operational, Sandy will review its own PRs. Expect that feedback.

## What we won't merge

- Code that hard-codes paths, file names, or conventions specific to one project
- Dependencies on a specific cloud SaaS unless gated behind a configuration flag
- Tests using real-world product code (use synthetic fixtures)
- Removal of the HTML comment trailer (`<!-- bot:finding=... archetype=... -->`) — load-bearing for the learning loop

## Releasing

Maintainer-only. Sandy follows semver. Versions are tagged in git; no npm publishing currently.
