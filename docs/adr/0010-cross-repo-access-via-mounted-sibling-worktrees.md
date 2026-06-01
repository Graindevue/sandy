# 10. Cross-repo access via mounted sibling worktrees; the Manifest is a trigger, not the knowledge source

Date: 2026-05-30

Status: Accepted

## Context

Sandy's headline feature is cross-repo awareness — catching, for example, a backend rename that breaks a desktop-app consumer in another Repo of the same Product (ADR 0002). ADR 0001 established that there is no persistent code graph and that the `ApiSurfaceManifest` carries cross-repo context, with callers resolved on demand by Agent tools (`rg`, `read_file`, `tree_sitter_query`).

That left an ambiguity ADR 0001's wording ("cross-repo navigation works via the Manifest + standard Agent tools") did not resolve: **does an Agent reviewing `acme-backend` physically have `acme-desktop`'s files in its sandbox, or only the Manifest summary?** Phase 1's `sandcastle-runner` mounts only the single PR worktree (plus the opensrc cache and Codex auth) — an Agent reviewing backend cannot read a single byte of desktop.

The canonical example forces the question. A rename `getActiveOrders` → `listActiveOrders` produces a diff where the *old* name appears only on the deleted side. The Manifest, built fresh at the PR SHA, lists only the *new* surface — it has no record that desktop ever called the old name. The only way to detect the break is for the Agent to take the old name from the diff and `rg` it **inside desktop's actual checkout**. A Manifest-only model structurally cannot catch the headline feature.

## Decision

Every other Repo in the Product is physically present in each Agent's sandbox:

- For each sibling Repo, per Review, Sandy fetches `origin`, resolves the default branch to a SHA, and cuts a **detached `git worktree` pinned to that SHA** — the same machinery the PR Repo already uses, generalized to siblings (ADR 0001's "no staleness" property is preserved: the mount matches a recorded SHA).
- Each sibling worktree is **bind-mounted read-only** at a stable path: `/workspace/<owner>/<name>`. The PR Repo remains the Agent's `cwd`. The prompt/Manifest tells the Agent the path ↔ `owner/name` mapping.
- The long-lived clone is only ever `fetch`ed (append-only objects) and `worktree add`/`remove`d — never checked out in place — so concurrent Reviews each pin their own sibling worktrees and never race.

The `ApiSurfaceManifest`'s role is narrowed accordingly. It is the **primary trigger** for Cross-Repo Search, not the source of cross-repo knowledge: when the PR diff changes/removes/adds a public-surface item the Manifest lists, the Agent is directed to `rg` the mounted siblings for consumers. A **secondary diff-judgment trigger** covers changes likely to affect another Repo that the Extractors do not model (external behavior, data shape/semantics, routes, events, config, auth, permissions, storage paths, generated artifacts, shared conventions). Cross-Repo Search does not run by default on every PR — local-only changes (CSS, tests) skip it unless the diff suggests contract risk — and the Agent always states why it searched or why it skipped (load-bearing for debuggability and the learning loop).

## Consequences

- **The headline feature is mechanically possible.** An Agent can `rg`/`read_file` real sibling code, not just a summary. Manifest-only would have silently failed the canonical case.
- **Division of labor is crisp.** Manifest = "did this PR touch a contract, and what is the current surface/version." Mounted siblings + `rg` = "who actually depends on it." The Manifest never enumerates callers (consistent with ADR 0001).
- **Mount cost is near-zero; search cost is gated.** Bind-mounting all siblings read-only is essentially free I/O; the expensive grep only fires when the diff intersects a contract, so a CSS-only PR wastes no tokens.
- **Per-Review sibling worktrees cost disk and teardown.** A K-Repo Product cuts ~K worktrees per Review and removes them on completion. Acceptable at Sandy's scale (small Products); the existing worktree teardown generalizes.
- **Siblings are read at default-branch HEAD only** — see ADR 0011 for what that means for how breaks are judged.

## When to revisit

Reconsider if (a) Products grow large enough that mounting every sibling per Review is materially slow or disk-heavy, suggesting selective mounting based on the diff; or (b) the diff-judgment trigger proves unreliable enough that a precomputed cross-repo reference index (the thing ADR 0001 declined) starts to pay for itself.
