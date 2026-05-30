# Default Extractors

This directory documents the Extractors shipped with Sandy. The implementations live in `packages/manifest-builder/src/extractors/`. Each Extractor produces one section of the `ApiSurfaceManifest` for a Repo.

## Built-in Extractors

- `framework-versions.ts` — reads `package.json` + lockfile, returns the resolved version map (Next.js, Convex, React, etc.). Used as cached system context so Agents know which version's source to fetch via `opensrc`.
- `npm-exports.ts` — parses `exports`, `main` / `module` / `types`, and `src/index.ts`-style entry points, returning exported symbols and signatures.
- `convex-api.ts` — extracts Convex queries, mutations, actions with arg / return type signatures.
- `convex-schema.ts` — extracts Convex schema tables, fields, and indexes from `convex/schema.ts`.
- `http-routes.ts` — extracts Next.js route handlers (`route.ts`) and Convex HTTP actions.
- `i18n-keys.ts` — scans locale files in `messages/`, `locales/`, or `i18n/` directories for declared keys.

## Adding custom Extractors

Drop a TypeScript file in `.config/extractors/` that default-exports an object matching the `ApiSurfaceExtractor` interface (see `packages/shared-types/`). The file is dynamic-imported at Review time; any extractor with the same key as a built-in overrides it.

Custom Extractors receive the cloned Repo's worktree path plus `readFile` and `listFiles` helpers.
