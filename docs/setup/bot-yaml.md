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
    # Optional: choose which Agents run for this Product. See "Agent selection".
    agents:
      - logic

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
| `agents` | list of strings | no | Agent keys to run for this Product. Omit to use the default selection (see below). |

These map to Sandy's `Product` type (`slug`, `name`).

### `products[].repos[]`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `owner` | string | yes | GitHub owner or org login, e.g. `tony-co`. |
| `name` | string | yes | Repository name, e.g. `acme-backend`. |
| `defaultBranch` | string | yes | The Repo's default branch, e.g. `main`. |

These map to Sandy's `Repo` type. The `owner`/`name` pair must match a repository
the GitHub App is installed on. `fullName` (`owner/name`) is derived by Sandy —
you don't write it.

## Agent selection

Agent keys are the file names (without `.md`) in `agents/` and
`.config/agents/`. The Agents shipped with Sandy:

| Key | Focus | Vendor / model |
|-----|-------|----------------|
| `logic` | Logic bugs, broken invariants, cross-file correctness | claude / opus |
| `security` | Auth, input validation, secrets, injection, data exposure | claude / opus |
| `convex` | Convex query/mutation/schema correctness | claude / opus |
| `nextjs` | Next.js Cache Components, async params, routing, server actions | claude / opus |
| `i18n` | i18n key consistency, hard-coded strings | codex / gpt-5.5 |
| `test-coverage` | Missing or over-mocked tests | claude / haiku |
| `style` | Maintainability Biome can't catch (verbose strictness only) | codex / gpt-5.5 |

> **Phase 1 runs only `logic`.** The other Agents are present in the repo but
> unused until multi-Agent fan-out activates in a later phase. In Phase 1, the
> effective selection is a single Agent regardless of what you list here; listing
> more does no harm but won't fan out yet. See
> [`docs/prds/phase-01-first-useful-review.md`](../prds/phase-01-first-useful-review.md).

To add a custom Agent, drop a markdown file in `.config/agents/` and reference
its key in a Product's `agents` list. A file there with the same name as a
shipped Agent overrides the default. The Agent definition format (frontmatter +
system-prompt body) is documented by the shipped examples in `agents/`.

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
