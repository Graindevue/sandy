# Sandy packages

- `@sandy/bot-worker` — the one-shot Actions review entry point, Codex execution,
  workspace preparation, Findings synthesis, and GitHub App posting. Reads and
  writes Convex state through its HTTP client.
- `@sandy/manifest-builder` — builds the per-Review Product ApiSurfaceManifest
  using registered source-text and package-metadata Extractors.
- `@sandy/convex-backend` — durable review state, history, and maintenance
  functions deployed to Convex Cloud. Learning tables remain for historical data.
- `@sandy/shared-types` — domain types shared across the packages.

See [CONTEXT.md](../CONTEXT.md) for vocabulary and
[ADR 0018](../docs/adr/0018-github-actions-codex-runtime.md) for the runtime.
