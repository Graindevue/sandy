# Setting up Sandy

Operator-facing setup for standing Sandy up end-to-end on a fresh host. These
docs are runnable walkthroughs — they describe behavior and the exact commands
to run, not Sandy's internals. For what Sandy is and the domain vocabulary, read
[`README.md`](../../README.md) and [`CONTEXT.md`](../../CONTEXT.md) first.

## Before you start

Sandy is **macOS on Apple Silicon (M1+) only** — [Apple Container][apple-container]
is required for Agent sandboxing (ADR [0003](../adr/0003-sandcastle-runtime-no-fork.md)).
You also need:

- **Node 24+** and **pnpm 10+**
- A **Convex** account (free tier is fine for solo workloads)
- A **GitHub** account with admin access to the repositories you want reviewed
- A **[Codex][codex]** login on the host — the Phase 1 `logic` Agent runs on
  Codex (`vendor: codex`). Run `codex login` once (uses your ChatGPT
  subscription); the worker stages that credential into each Agent container
  (see [`sandcastle-image.md`](./sandcastle-image.md)). An OpenAI API key, or
  running `logic` on **[Anthropic][anthropic]** Claude instead, are both
  supported — see [`github-app.md`](./github-app.md)
- **[Tailscale][tailscale]** for webhook ingress (recommended)
- **[`opensrc`][opensrc]** installed globally (ADR [0008](../adr/0008-opensrc-for-framework-source-truth.md))

Clone Sandy onto the host and install workspace dependencies:

```bash
git clone https://github.com/tony-co/sandy.git
cd sandy
pnpm install
```

Instance-specific configuration lives in `.config/` (gitignored). You will
create `.config/.env` and `.config/bot.yaml` as you work through these docs.

## Setup order

Follow these in order. Each builds on the previous one.

| # | Doc | What it covers |
|---|-----|----------------|
| 1 | [`sandcastle-image.md`](./sandcastle-image.md) | Install host tooling (`opensrc`, Codex CLI + `codex login`) and build the Apple Container image Agents run in. |
| 2 | [`convex.md`](./convex.md) | Create a Convex deployment and deploy the Phase 1 schema. |
| 3 | [`github-app.md`](./github-app.md) | Register the "Sandy" GitHub App, install it on repos, capture credentials into `.config/.env`. |
| 4 | [`tailscale.md`](./tailscale.md) | Expose the webhook server (host port **3007**) to GitHub via Tailscale Funnel. |
| 5 | [`bot-yaml.md`](./bot-yaml.md) | Author `.config/bot.yaml` — declare your Products, their Repos, Agent selection, and runtime overrides. |
| 6 | [`launchd.md`](./launchd.md) | Install a launchd service that supervises the worker and runs it on boot. |

After the launchd service is running and the Funnel URL is registered as the
App's webhook, post `@bot review` on a pull request in a registered Repo to
trigger the first Review.

## What's deferred

Phase 1 ships a single-Agent, single-Product, single-Repo loop. Multi-Agent
fan-out, the API surface manifest, per-Repo `.bot/` rules, and the learning loop
arrive in later phases — see [`docs/prds/`](../prds/). Where one of these docs
mentions a not-yet-built feature, it says so.

[apple-container]: https://github.com/apple/container
[codex]: https://github.com/openai/codex
[anthropic]: https://console.anthropic.com/
[tailscale]: https://tailscale.com/
[opensrc]: https://opensrc.run
