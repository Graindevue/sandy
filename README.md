# Sandy

Self-hosted code review automation for GitHub pull requests, designed for solo developers who maintain a few related repositories.

## What it is (and isn't)

Sandy receives GitHub PR webhooks, runs one or more LLM agents over the diff in sandboxed Apple Containers, and posts inline comments back to the PR. It learns from your 👍/👎 reactions over time and can reason across multiple repositories that form one product.

It is **not** a smarter reviewer than you'd get from `gh pr view --diff | claude -p "review this for bugs"` — the underlying review quality is bounded by whichever model is doing the thinking. What Sandy adds is workflow: it runs without you remembering, sees your other repositories, posts where PR conversations already happen, and over time learns which patterns to suppress.

If 80% of the value of code-review automation is "an LLM reads the diff," Sandy is the other 20% — the integration, the cross-repo context, the learning loop — packaged into something self-hosted you can run on a Mac mini.

## Honest scope

**What Sandy does well**

- Reviews any PR — code you wrote in Claude Code, manual edits, collaborator contributions. Not just bot-generated branches.
- Multi-agent fan-out — specialized prompts (logic / security / Convex / Next.js / i18n) tend to find more than one general-purpose prompt does.
- Cross-repo Product context — a backend rename that breaks a desktop-app consumer is visible to Sandy, invisible to a single-repo reviewer.
- Reactive — every push retriggers automatically once you've opted a PR in. Nothing to remember.
- Self-hosted — runs on your hardware. No SaaS reviewer in the loop.

**What Sandy doesn't claim**

- Bug-catching superpowers. If a model can't catch a bug from the diff + repo context, Sandy can't either, no matter how many agents fan out.
- A finished learning loop. The reaction-driven suppression and rule-promotion system is the optimistic bet that separates Sandy from a one-shot review script. Hosted reviewers have struggled with this for years, and solo-rater bias is worse, not better. We'll see how it holds up.
- Portability. Sandy is macOS-only — Apple Container is required for agent sandboxing.
- Cost neutrality. Multi-agent fan-out across PRs adds up. Sandy is for people who'd happily pay for review quality, not people optimizing API spend.

## Built on sandcastle 🏖️

Sandy stands on the shoulders of [`sandcastle`](https://github.com/mattpocock/sandcastle) by [Matt Pocock](https://github.com/mattpocock).

Sandcastle is the runtime layer that makes Sandy possible — it spawns LLM coding agents inside Apple Container sandboxes, dispatches across vendors (Claude, Codex, Cursor, Copilot), and handles every line of container-lifecycle plumbing you don't want to write yourself.

Sandy is essentially what happens when you take sandcastle's "AFK long-running coding agent" runtime and graft a webhook server, a reactive Convex queue, a cross-repo manifest, a findings synthesizer, and a learning loop on top.

Without sandcastle, Sandy would be ~10x the code and substantially worse. Go check it out.

## How it works

```
GitHub PR webhook
  → Sandy webhook receiver (Node, on your host)
  → Convex (enqueue ReviewJob via OCC-protected mutation)
  → Worker reactively subscribes to Convex pending queue
  → Sandcastle spawns N parallel Agents in Apple Containers
    → Each Agent reads the diff + Product context + framework sources via opensrc
    → Each Agent emits structured findings via completion-signal output
  → Synthesizer dedupes, applies learned suppressions, scores Findings
  → Posts inline comments + summary to the PR via the GitHub App
  → Reactions on bot comments feed back into Convex → Archetypes → SuggestedRules
```

Read [`CONTEXT.md`](./CONTEXT.md) for the domain glossary, [`docs/adr/`](./docs/adr/) for architectural decisions, and [`docs/prds/`](./docs/prds/) for the implementation roadmap.

## Status

Early. The architecture is settled — see the ADRs for the decisions and their rationale. Phase 1 (single-Agent end-to-end loop) is what ships first; subsequent phases activate multi-agent fan-out, the API surface manifest, and the learning loop.

## Requirements

- **macOS on Apple Silicon (M1+)** — Apple Container is mac-only
- **Node 24+**, **pnpm 10+**
- **A Convex account** — free tier is sufficient for solo workloads
- **A GitHub App** registered against the repositories you want reviewed
- **[Tailscale](https://tailscale.com/)** (recommended) for webhook ingress
- **[`opensrc`](https://opensrc.run)** installed globally — Sandy uses it to read framework source for the installed version, bypassing LLM training cutoffs

## Quickstart

Detailed setup documentation lands with Phase 1. High-level shape:

1. Clone Sandy onto your host machine
2. Install `opensrc` globally
3. Build the Apple Container image used by agents
4. Deploy the Convex schema
5. Register a GitHub App, drop credentials in `.config/.env`
6. Define your Products in `.config/bot.yaml`
7. Start Tailscale Funnel on port 3007
8. `pnpm start` — production runs supervised by launchd

## Configuration

Instance-specific configuration lives in `.config/` (gitignored). Default Agent personas and Extractors ship in the repository root (`agents/`, `extractors/`) and apply to any Product. Add custom Agents or Extractors by dropping files in `.config/agents/` or `.config/extractors/`.

To version-control your `.config/` privately, initialize git inside it as a nested repository — Sandy's `.gitignore` excludes the directory at the parent level, so it can carry its own private history.

## Should you use Sandy?

Probably no, unless:

- You self-host services on a Mac mini and another runtime isn't friction.
- You maintain 2+ repositories that share a domain and you keep getting bitten by cross-repo contract drift.
- You're philosophically allergic to running your code through a SaaS code reviewer.
- You like the idea of a reviewer you can teach, not one whose behavior is fixed by a vendor.

If none of those describe you, a hosted code-review service is probably a faster path to value, and there's nothing wrong with that.

## License

MIT. See [`LICENSE`](./LICENSE).
