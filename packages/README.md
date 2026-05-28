# Sandy packages

Implementation packages, stubbed for Phase 1.

## Planned packages

- `@sandy/bot-worker` — webhook receiver + worker process. The main long-running Node service on the host. Subscribes to Convex `reviewJobs`, invokes Sandcastle, runs the Synthesizer, posts to GitHub.
- `@sandy/apple-container-provider` — Apple Container `SandboxProvider` for `@ai-hero/sandcastle`, copied (and MIT re-licensed) from graindevue's `.sandcastle/` per [ADR 0009](../docs/adr/0009-apple-container-provider-copied-from-graindevue.md). Consumed by `@sandy/bot-worker`; intended for eventual upstreaming.
- `@sandy/manifest-builder` — assembles the per-Review `ApiSurfaceManifest` by running registered Extractors over each Repo's worktree.
- `@sandy/convex-backend` — the Convex schema and function definitions. Deployed to Convex Cloud.
- `@sandy/shared-types` — TypeScript types shared across packages: `Product`, `Repo`, `ReviewJob`, `Finding`, `Archetype`, `Rule`, `SuggestedRule`, `ApiSurfaceManifest`, `Extractor`, `AgentDefinition`, etc.

These will be scaffolded in Phase 1 implementation. The architecture they implement is documented in [`CONTEXT.md`](../CONTEXT.md) and [`docs/adr/`](../docs/adr/).
