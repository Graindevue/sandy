# Product and Agent configuration

`bot.yaml` declares Products, their Repos, and reviewer selection. Local instance
configuration lives in gitignored `.config/bot.yaml`. Actions can use generated
single-Repo configuration or a non-secret file from the caller's trusted default
branch; [github-actions.md](./github-actions.md) describes its `config-path`.

A Repo is reviewed only when it is configured and the GitHub App is installed
on it. Each Repo belongs to exactly one Product.

## Example

```yaml
products:
  - slug: acme
    name: Acme
    repos:
      - owner: your-org
        name: acme-backend
        defaultBranch: main
      - owner: your-org
        name: acme-desktop
        defaultBranch: main
    agents:
      enable: [logic, security, convex]
      overrides:
        logic:
          vendor: codex
          model: gpt-5.5
          effort: xhigh
        security:
          vendor: codex
          model: gpt-5.5
          effort: high
        convex:
          vendor: codex
          model: gpt-5.5
          effort: high
```

Product `slug` is a stable identity used in Convex: keep it lowercase and avoid
renaming it. Every Repo needs its exact GitHub `owner`, `name`, and
`defaultBranch`. `fullName` is derived by Sandy. The reviewed Repo uses the PR
head; siblings use their configured default-branch revisions.

`excludeBranches` is accepted for historical config compatibility and is inert
because review requests are manual-only. It does not restrict mentions or
workflow dispatch.

## Agent selection

Keys are filenames without `.md` in `agents/` and `.config/agents/`.
The current generated Actions configuration uses `logic`, `security`, and
conditional `convex`. The Convex persona runs only when the reviewed diff
touches a `convex/` directory. When dependencies install and a project test script
is available, Sandy runs the suite once and includes its result in reviewer
context; a separate coverage persona is not part of the generated
selection. Next.js, style, and other legacy personas remain available for
explicit custom selection.

List form chooses an exact set:

```yaml
agents: [logic, security]
```

Object form adds runtime overrides:

```yaml
agents:
  enable: [logic, security]
  overrides:
    logic: { vendor: codex, model: gpt-5.5, effort: xhigh }
    security: { vendor: codex, model: gpt-5.5, effort: high }
```

Without an exact set, Sandy considers each persona's `defaultEnabled` value:
`true` is selected, `false` is off, and `auto` depends on framework detection.
Repo-local `.bot/agents.yaml` can enable/disable allowed personas. It cannot
change the operator's runtime selection or expand an exact Product set.

## Runtime overrides

The Actions runner supports **`vendor: codex`**. Existing non-Codex config may
parse for compatibility, but selected non-Codex personas cannot execute.
Override every selected legacy persona to Codex or update its definition.

An override replaces `vendor`, `model`, and optional `effort` together. Both
vendor and model are required. Codex effort values are `low`, `medium`, `high`,
and `xhigh`; omission uses the CLI default even when the persona defines effort.

Overrides keep the prompt, tools, category, and completion signal. To customize
those, provide an instance persona with the same filename; to add a new persona,
provide a new markdown file and select its key. Every selected persona executes
one Codex invocation with at most one completion resume. The legacy
`maxIterations` field is compatibility metadata and does not create a repeated
execution loop.

## Rules and reloads

Repo-local Rules live in `.bot/rules.md`; Product Rules come from the union of
`.bot/product-rules.md` in its Repos. They are reviewed-version context, not
operator credentials or a choice of runtime provider.

Each Actions job loads config once. A default-branch config change applies to
the next request; there is no persistent process to restart.
