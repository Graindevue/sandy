# 8. opensrc for framework source-of-truth access

Date: 2026-05-28

Status: Accepted; provisioning amended by [0018](./0018-github-actions-codex-runtime.md)

> **Current amendment (2026-10-09).** `opensrc` and finding-gated source verification remain. The composite action installs and caches the CLI on the Linux runner; host/container installation and bind mounts below are historical.

## Context

LLM training data has cutoff dates. Frameworks ship continuously. Sandy reviews PRs touching Next.js, Convex, React, Stripe SDK, Better Auth, and other frameworks whose major features ship faster than any model's training cycle. Without source-of-truth access at Review time, Agents either:

- Flag code as wrong based on outdated framework mental models (false positives)
- Miss real bugs in new framework features they don't recognize (false negatives)
- Hallucinate framework APIs that no longer exist (incorrect suggestions)

The [`opensrc`](https://opensrc.run) CLI fetches actual source code for npm / PyPI / crates / GitHub dependencies on demand and caches it locally.

## Decision

Sandy requires `opensrc` to be installed on the host machine and inside the Apple Container image used by every Agent. The host's `~/.opensrc` cache directory is mounted into each container (this mirrors the existing pattern in `@ai-hero/sandcastle` at `.sandcastle/main.mts:84-91` in graindevue's setup).

Framework-aware Agent prompts (`agents/convex.md`, `agents/nextjs.md`, `agents/i18n.md`, etc.) explicitly instruct the Agent to invoke `opensrc path <package>` before commenting on usage of recent framework features.

A built-in Extractor (`extractors/framework-versions.ts`) reads each Repo's `package.json` and lockfile to produce a resolved version map. This map is included in every Review's cached system context so Agents know which framework version's source to fetch.

## Consequences

- **Hard host dependency.** `opensrc` must be installed on the mac mini and baked into the Apple Container image. Documented as a prerequisite in `README.md`.
- **Network access required inside containers** for first-time source fetches. The mounted `~/.opensrc` cache eliminates repeat downloads across Reviews.
- **Increased per-Review token usage** when Agents fetch large framework sources. Mitigated by:
  - Caching opensrc downloads on the host (one fetch per package version, reused across Reviews)
  - Prompt guidance: "use opensrc only when uncertain about framework behavior; do not fetch source preemptively"
- **Framework Reviews are dramatically more accurate** for recently-shipped features (Next.js 16 Cache Components, new Convex APIs, React 19.2 idioms) — Agents verify behavior against real source rather than training-cutoff knowledge.
- **Disk usage grows** as more framework versions are cached. Periodic pruning may be needed.

## When to revisit

Reconsider if (a) `opensrc`'s network calls become a problem on locked-down hosts, (b) Anthropic / OpenAI ship native dep-source-lookup tools that supersede this approach, (c) the cached `~/.opensrc` directory grows large enough to need disk-quota management, or (d) a framework changes its distribution format in a way that breaks `opensrc`.
