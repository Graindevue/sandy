# `.config/bot.yaml` schema reference

`bot.yaml` is where you declare what Sandy reviews: your **Products**, the
**Repos** each Product contains, and which **Agents** run. It lives at
`.config/bot.yaml` (gitignored — instance-specific, per the repo `.gitignore`).
A Repo is reviewed only if it is declared here **and** the
[GitHub App](./github-app.md) is installed on it.

> **Status — schema reference only.** This documents the **intended** schema. The
> config *loader* that reads and validates `bot.yaml`
> (`packages/bot-worker/src/config/loader.ts`) ships in a separate Phase 1 issue.
> Field names below match Sandy's shared types (`Product`, `Repo`,
> `AgentDefinition`) so the file you author now lines up with the loader when it
> lands. If a field here and the merged loader ever disagree, the loader wins —
> open an issue to reconcile this doc.

## Concepts

- A **[Product](../../CONTEXT.md#product)** is the unit at which Sandy reasons
  about cross-repo context. It groups one or more Repos that form one logical
  software product. (Cross-repo reasoning itself activates in a later phase;
  declaring the Product correctly now is still how Sandy knows which Repos belong
  together.)
- A **[Repo](../../CONTEXT.md#repo)** is a single GitHub repository belonging to
  exactly one Product. Sandy clones it to local disk and keeps it current via
  webhooks.
- An **[Agent](../../CONTEXT.md#agent)** is a reviewer persona defined by a
  markdown file in `agents/` (shipped defaults) or `.config/agents/`
  (per-instance). Agents are configuration data, not code.

## Minimal example

The smallest useful config — one Product, one Repo, the default Agent set:

```yaml
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
```

## Full example

> **Phase 1 tests one Product, one Repo, one Agent.** The multi-Product,
> multi-Repo file below is valid schema and shows every field, but Phase 1 only
> exercises a single Product with a single Repo (and only the `logic` Agent — see
> "Agent selection"). Multiple Products/Repos parse, yet cross-repo reasoning and
> fan-out don't activate until later phases; the single-Product/single-Repo path
> is the only one Phase 1 has been tested against.

```yaml
products:
  # A Product that spans two Repos (one backend, one desktop app).
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
      - owner: tony-co
        name: acme-desktop
        defaultBranch: main
        excludeBranches:
          - release/*
          - vendor/**
    # Optional: choose which Agents run for this Product and override their
    # runtime vendor/model (and, optionally, reasoning effort). See "Agent
    # selection".
    agents:
      enable: [logic, security]
      overrides:
        logic:
          vendor: codex
          model: gpt-5.6
          effort: xhigh

  # A second, unrelated Product.
  - slug: sandy
    name: Sandy
    repos:
      - owner: tony-co
        name: sandy
        defaultBranch: main
```

## Field reference

### `products[]`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `slug` | string | yes | Stable identifier used in config, logs, and Convex. Lowercase, e.g. `acme`. Must be unique across the file. |
| `name` | string | yes | Human-readable display name. |
| `repos` | list | yes | One or more Repos (below). Must be non-empty. |
| `agents` | list of strings or mapping | no | Product-level Agent selection and runtime overrides. Omit to use the default selection with no overrides (see below). |

These map to Sandy's `Product` type (`slug`, `name`).

### `products[].repos[]`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `owner` | string | yes | GitHub owner or org login, e.g. `tony-co`. |
| `name` | string | yes | Repository name, e.g. `acme-backend`. |
| `defaultBranch` | string | yes | The Repo's default branch, e.g. `main`. |
| `excludeBranches` | list of strings | no | Glob patterns for base branches where Sandy skips automatic draft → ready Review arming. Omit or use `[]` to exclude nothing. |

These map to Sandy's `Repo` type. The `owner`/`name` pair must match a repository
the GitHub App is installed on. `fullName` (`owner/name`) is derived by Sandy —
you don't write it.

### Base-Branch Exclusion

`excludeBranches` is a per-Repo denylist. It matches the PR's base branch
(target branch), not the head branch:

```yaml
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
        excludeBranches:
          - release/*
          - vendor/**
          - sandbox
```

Exact branch names work as patterns (`sandbox` matches only `sandbox`). Glob
patterns use Node's `matchesGlob` semantics and are case-sensitive, like Git
refs. `release/*` matches `release/2026.06`; `vendor/**` matches nested branch
names such as `vendor/generated/current`.

The exclusion gates only automatic Sticky Opt-In from `gh pr ready`
(`ready_for_review`). PR open/reopen behavior is unchanged, and `@bot review`
always overrides the exclusion. After a human opts in an excluded-branch PR with
`@bot review`, subsequent pushes retrigger Reviews normally. A skipped automatic
trigger posts no PR comment.

## Agent selection

Agent keys are the file names (without `.md`) in `agents/` and
`.config/agents/`. The Agents shipped with Sandy:

| Key | Focus | Vendor / model |
|-----|-------|----------------|
| `logic` | Logic bugs, broken invariants, cross-file correctness | codex / gpt-5.5 |
| `security` | Auth, input validation, secrets, injection, data exposure | claude / opus |
| `convex` | Convex query/mutation/schema correctness | claude / opus |
| `nextjs` | Next.js Cache Components, async params, routing, server actions | claude / opus |
| `i18n` | i18n key consistency, hard-coded strings | codex / gpt-5.5 |
| `test-coverage` | Missing or over-mocked tests | claude / haiku |
| `style` | Maintainability Biome can't catch (verbose strictness only) | codex / gpt-5.5 |

### Selection forms

Omit `agents` to use default/auto Agent selection:

```yaml
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
```

Use list form for an exact Product Agent set. This preserves the original
schema:

```yaml
agents: [logic, security]
```

Use object form when you need runtime overrides:

```yaml
agents:
  enable: [logic, security]
  overrides:
    logic:
      vendor: codex
      model: gpt-5.6
```

`agents.enable` is an exact Product Agent set, equivalent to the list form. When
`agents.enable` is omitted, default/auto selection still applies:

```yaml
agents:
  overrides:
    logic:
      vendor: codex
      model: gpt-5.6
```

`agents: {}` and `agents.overrides: {}` are valid no-ops.

When a Product omits `agents` or uses object form without `enable`, Sandy starts
from each Agent's `defaultEnabled` frontmatter: `true` runs by default, `false`
stays off, and `auto` runs only when a Product Repo declares the relevant
framework dependency in `package.json`. The reviewed Repo can then enable or
disable Agents with `.bot/agents.yaml`:

```yaml
enable: [style]
disable: [security]
```

Repo-local `.bot/agents.yaml` cannot override vendor/model and cannot add Agents
outside a Product's exact `agents` / `agents.enable` set. Runtime selection is
operator-owned instance policy in `.config/bot.yaml`, not repo-owned policy.

### Runtime overrides

An Agent runtime override changes only an existing Agent's runtime selection —
`vendor`, `model`, and optionally `effort`. It does not change the Agent's
prompt, tools, completion signal, category, or default-enabled behavior. To
change those, replace the Agent definition with a matching file in
`.config/agents/`.

Each override entry must specify both `vendor` and `model`; `effort` is
optional:

```yaml
agents:
  overrides:
    security:
      vendor: claude
      model: opus
      effort: high
```

`effort` sets the vendor CLI's reasoning effort and is validated per vendor at
config load:

| Vendor | Accepted `effort` values |
|--------|--------------------------|
| `claude` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `low`, `medium`, `high`, `xhigh` |
| `copilot` | `low`, `medium`, `high` |
| `cursor` | none — setting `effort` is a config error |

Omitting `effort` uses the vendor CLI's default. The same field is accepted in
Agent definition frontmatter (next to `vendor`/`model`), but an override is the
complete runtime selection: when an override targets an Agent, a frontmatter
`effort` does not carry over — an override without `effort` runs the Agent at
the vendor default.

Overrides apply after `.config/agents/<key>.md` is loaded. They may target any
known Agent key and are inert unless that Agent is selected for a Review. Unknown
Agent keys fail config load.

To add a custom Agent, drop a markdown file in `.config/agents/` and reference
its key in a Product's list-form `agents` value or object-form `agents.enable`.
A file there with the same name as a shipped Agent overrides the default. The
Agent definition format (frontmatter + system-prompt body) is documented by the
shipped examples in `agents/`.

## Authoring tips

- Keep `slug` values short and stable — they appear in logs and Convex `products`
  rows, and renaming one later orphans existing records.
- One Repo belongs to exactly one Product. Don't list the same `owner/name` under
  two Products.
- Reloading: the worker re-reads `bot.yaml` on restart. The recommendation for
  v1 is that `SIGHUP` triggers a reload with no automatic file-watch (see the
  Phase 1 PRD open questions); until that's wired, restart the
  [launchd service](./launchd.md) after editing this file.

## Next

With `bot.yaml` in place, install the [launchd service](./launchd.md) so the
worker comes up on boot, then post `@bot review` on a PR in one of the Repos
above.
