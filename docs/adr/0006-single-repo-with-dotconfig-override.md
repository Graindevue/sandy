# 6. Single repository with `.config/` for instance overrides

Date: 2026-05-28

Status: Accepted

## Context

Sandy is open-source (MIT) but each instance is configured for a specific user's repositories, rules, secrets, and custom agents. There must be a clean separation between the open-source core and per-instance configuration.

Two options were evaluated:

- **A)** Two repositories: `sandy/` (public) + `<user>-sandy-config/` (private), with a sibling-directory plugin-loading convention.
- **B)** A single repository with a gitignored `.config/` subdirectory holding per-instance content.

## Decision

Sandy is a single repository. Instance configuration lives in a gitignored `.config/` directory inside the repo.

```
sandy/
├── agents/                  # default Agent personas (versioned, open-source)
├── extractors/              # default Extractors (versioned, open-source)
├── packages/                # core code
├── .config/                 # gitignored, per-instance
│   ├── bot.yaml             # products, vendor keys (refs only)
│   ├── agents/              # override defaults or add new Agents
│   ├── extractors/          # custom Extractor TS files
│   ├── launchd/             # plists for the host machine
│   └── .env                 # secrets
└── .gitignore               # ignores .config/ entirely
```

Override semantics: at startup, Sandy loads `agents/*.md` and `extractors/*.ts` from the repo root, then overlays anything from `.config/agents/` and `.config/extractors/`. Same filename = override; new filename = addition.

Users who want their `.config/` version-controlled in a private repo can initialize git inside `.config/` itself (nested git repo). Sandy's `.gitignore` excludes the directory at the parent level, so the inner history is hidden from the public repo.

## Consequences

- **Simpler onboarding.** One repository to clone, not two.
- **No two-repo coordination headaches.** Refactors that span core + default Agents stay in one PR.
- **Risk of accidentally committing `.config/`.** Mitigated by `.gitignore`. A pre-commit hook scanning for likely-secret patterns (private keys, tokens) is recommended.
- **Instance config can still be privately versioned** via nested git in `.config/` — best of both worlds.
- **Plugin loading is filesystem-based**, not registry-based. No npm publishing required for custom Extractors. Dynamic import from `.config/extractors/*.ts` is sufficient.
- **Defaults are open-source by definition.** Anything shipped in `agents/` or `extractors/` is publicly visible. This forces clear discipline about what's a project-specific custom vs a framework-aware default.

## When to revisit

Reconsider splitting if Sandy gains real third-party adopters and the discipline cost of "do not commit anything project-specific to the core repo" outweighs the simplicity benefit. A future ADR could carve out a separate `sandy-defaults` package while keeping the runtime open-source.
