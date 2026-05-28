# 4. Convex Cloud for state, reactive queue, and scheduler

Date: 2026-05-28

Status: Accepted

## Context

Sandy needs durable state for: queued ReviewJobs, Findings, Archetypes, Reactions, SuggestedRules, ApiSurfaceManifests, and agent-run history. It needs a queue that survives process restarts and machine reboots. It needs scheduled jobs (queue reaper, archetype rollups, periodic refreshes).

Three options were evaluated:

- **A)** SQLite on the host. Zero new dependencies, but: manual schema migrations, no reactivity, no multi-device access, manual backups.
- **B)** Convex Cloud (free tier). Schema as TypeScript, OCC-protected mutations, reactive queries, built-in cron, automatic backups, accessible from any device. External dependency.
- **C)** Self-hosted Convex backend. Open-source Convex deployed in a container. Preserves "self-hosted" purity, but trades SQLite operational burden for Convex-backend operational burden.

## Decision

Sandy uses Convex Cloud (free tier) for all durable state. The Node worker on the host machine subscribes reactively to `reviewJobs` filtered by `status === 'pending'` and claims jobs via OCC-protected mutations.

The schema lives in `packages/convex-backend/convex/schema.ts`. Tables: `products`, `repos`, `pullRequests`, `reviewJobs`, `findings`, `archetypes`, `reactions`, `suggestedRules`, `apiSurfaceManifests`, `agentRuns`.

The free tier comfortably covers solo workloads (Sandy will use <50k function calls/month against a 1M cap).

## Consequences

- **No SQLite migrations to write.** Schema is TypeScript; Convex handles versioning.
- **Multi-device access.** A future operator CLI, dashboard, or MCP tool can read the same state from anywhere with Convex credentials.
- **Reactive queue.** No polling; the worker subscribes and reacts to new ReviewJobs as Convex pushes them.
- **OCC-protected dequeues.** Concurrent claim attempts resolve atomically without explicit locking.
- **Free operator UI.** The Convex Dashboard handles SuggestedRule promotion and review without Sandy shipping its own dashboard.
- **External dependency on Convex Cloud.** The original spec leaned "self-hosted, no SaaS." This decision relaxes that goal for the storage layer specifically. Bot logic and Sandcastle still run on the host.
- **Convex outages affect Sandy.** Worker can't claim jobs during a Convex outage; webhook receiver can't enqueue. Acceptable: Convex's uptime is high, and GitHub webhooks retry on failure.

## When to revisit

Reconsider self-hosting Convex backend (`convex-backend` Docker image) if (a) Convex Cloud's free-tier limits become binding, (b) Convex Cloud has policy changes incompatible with use, or (c) external dependencies become unacceptable for a future deployment.
