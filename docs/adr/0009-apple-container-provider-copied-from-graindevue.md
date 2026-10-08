# 9. Apple Container provider is copied (and re-licensed) from graindevue's `.sandcastle/`

Date: 2026-05-28

Status: Superseded by [0018](./0018-github-actions-codex-runtime.md)

> **Historical decision.** ADR 0018 removes the copied provider and container images. The original packaging and licensing decision below is preserved for history.

## Context

`@ai-hero/sandcastle` exposes `createBindMountSandboxProvider` — a generic interface for plugging in a sandbox backend (Docker, Podman, Apple Container, etc.). The package ships with a Docker provider out of the box but **does not ship an Apple Container provider**.

Sandy's runtime is macOS-only and depends on Apple Container for agent sandboxing (ADR 0003). The Apple Container provider must live somewhere — upstream sandcastle, Sandy itself, or a separate package.

A working Apple Container provider already exists at `~/projects/graindevue/.sandcastle/apple-container.ts` (with its companion `mount-utils.ts` and unit tests). It is ~700 lines of substantive plumbing: signal-safe container teardown, UID validation against the image, streaming `copyFileIn` / `copyFileOut` (Apple's `container cp` doesn't ship yet — see file comments), DNS injection (Apple Container VMs have no DNS by default), memory/CPU defaults tuned for monorepo type-check workloads, and worktree-`.git` mount filtering.

## Decision

Sandy copies graindevue's Apple Container provider into the Sandy repository under MIT license. Files copied:

- `.sandcastle/apple-container.ts` → `packages/apple-container-provider/src/apple-container.ts`
- `.sandcastle/mount-utils.ts` → `packages/apple-container-provider/src/mount-utils.ts`
- `.sandcastle/apple-container.test.ts` → `packages/apple-container-provider/src/apple-container.test.ts`

The provider lives in its **own package** (`packages/apple-container-provider/`), not inlined inside `packages/bot-worker/`. Reasons:

- Keeps the import surface clean: `import { appleContainer } from '@sandy/apple-container-provider'`.
- Makes upstreaming straightforward: if accepted into `@ai-hero/sandcastle/sandboxes/apple-container`, the local package is deleted and one import path changes.
- Allows independent versioning and testing.

The copied files gain a short header note: "Originally developed for graindevue's sandcastle integration; intended to be upstreamed to `@ai-hero/sandcastle` over time."

The Dockerfile is **NOT** copied. Graindevue's `.sandcastle/Dockerfile` bakes in Convex / Next.js / Stripe SDK and codebase-specific tooling. Sandy ships its own purpose-built Dockerfile with `opensrc` and the toolset Sandy's agents actually need (`rg`, `tree-sitter`, `gh`, etc.).

## Consequences

- **Sandy ships on day one** without waiting for upstream sandcastle to release Apple Container support.
- **License clarity** — Sandy's MIT covers the copied provider; the original code is the author's to re-license.
- **Upstream-ready packaging** — `packages/apple-container-provider/` exports `appleContainer(options): SandboxProvider` matching sandcastle's existing contract. Future migration is mechanical.
- **Maintenance burden** — Sandy carries any Apple Container patches until upstream accepts them. Acceptable given the code is stable and well-tested in graindevue's pipeline.
- **Dockerfile divergence is intentional** — graindevue's image is over-specified for Sandy's needs. Sandy's image is leaner and avoids leaking project-specific tooling assumptions into the public repo.

## When to revisit

- **Upstreaming accepted**: drop the local package, consume `@ai-hero/sandcastle/sandboxes/apple-container` instead.
- **Apple ships `container cp`**: replace the `streamCopyFileIn` / `streamCopyFileOut` heredoc pipework with native commands.
- **Apple Container becomes unsuitable** (e.g., Linux deployment desired): swap in another backend (Lima, Colima, etc.) implementing the same `SandboxProvider` contract. Bot-worker code is unaffected.

## Action item for Phase 1

Phase 1 implementation must:

1. Create `packages/apple-container-provider/` with its own `package.json`, `tsconfig.json`, `vitest.config.ts`.
2. Copy the three files, update import paths (`@ai-hero/sandcastle` package imports stay; relative imports stay relative).
3. Add the origin/attribution header note.
4. Wire `@sandy/apple-container-provider` as a workspace dependency of `@sandy/bot-worker`.
5. Update Phase 1 PRD's package list to include the provider.
