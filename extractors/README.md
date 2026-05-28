# Default Extractors

This directory holds the Extractors shipped with Sandy. Each Extractor produces one section of the `ApiSurfaceManifest` for a Repo.

## Built-in Extractors (TODO — Phase 2)

- `framework-versions.ts` — reads `package.json` + lockfile, returns the resolved version map (Next.js, Convex, React, etc.). Used as cached system context so Agents know which version's source to fetch via `opensrc`.
- `npm-exports.ts` — parses `packages/*/src/index.ts`-style entry points via `ts-morph`, returns exported type signatures.
- `convex-api.ts` — extracts Convex queries, mutations, actions with arg / return type signatures.
- `convex-schema.ts` — extracts Convex schema tables, fields, and indexes from `convex/schema.ts`.
- `http-routes.ts` — extracts Next.js route handlers (`route.ts`) and Convex HTTP actions.
- `i18n-keys.ts` — scans locale files in `messages/`, `locales/`, or `i18n/` directories for declared keys.

## Adding custom Extractors

Drop a TypeScript file in `.config/extractors/` that default-exports an object matching the `Extractor` interface (see `packages/shared-types/`). The file is dynamic-imported at Sandy startup; any extractor with the same filename as a built-in overrides it.

Custom Extractors are loaded relative to `.config/extractors/` and have access to `read_file`, `rg`, and the cloned Repo's worktree path.
