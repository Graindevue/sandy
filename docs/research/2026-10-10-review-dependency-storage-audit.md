# Review preparation and storage audit

The latest reviews of Graindevue PRs 744, 745 and 746 completed after falling
back from parallel to serial execution. Copying the second private workspace
failed with ENOSPC before Agent admission. This established disk exhaustion,
not a RAM requirement or concurrent authentication failure.

The audited Sandy deployment was
`3c10bfea97f13a4d05b32c5c3eae86857179bdfc`. The three reviewed heads were
`c67c56490058068310826ff33eb611b9cdc56028`,
`a8f82bef9fe702718aeabb2668047e160cce3a18`, and
`1f427e273b41f61503ce1f5293f713b071b91688`. Their dependency inputs matched.

## Dependency measurements

Fresh Linux x64 installations used Node 24.21.0 and the repository's pinned
pnpm 12.10.1, in disposable ext4 VMs with x64 userland under emulation. Lifecycle
scripts were disabled for the size comparison. These measurements establish
installation size; they are not a production RAM or wall-clock benchmark.

| Artifact | Repository architecture policy | Native Linux x64 glibc |
| --- | ---: | ---: |
| Root node_modules | 3.991 GiB | 1.896 GiB |
| Prepared worktree | 4.022 GiB | 1.927 GiB |
| Download store | 3.843 GiB | 1.764 GiB |
| Seed plus three private copies | 16.087 GiB | 7.709 GiB |
| Package directories | 1601 | 1465 |

All 136 removed packages were platform variants. No non-platform package was
removed. Lockfile, manifest and source hashes were unchanged. Native Biome,
Turbo, Fallow, Syncpack, Lefthook, sharp, Next SWC and esbuild checks agreed
between policies, as did lint, focused test suites and UI type checking. One
scripts test suite failed in both environments because the fixture lacked
ripgrep. The full production CI suite was not reproduced in these VMs.

The managed preparation HOME also retained roughly 0.43 GiB of pnpm registry
metadata. It was separate from the download store already removed by Sandy.

## Corrections

- pnpm 12 rejects `fetch --frozen-lockfile`. Fetch already freezes internally;
  the flag remains necessary on the subsequent installation. See the
  [pinned fetch arguments](https://github.com/pnpm/pnpm/blob/v12.10.1/pnpm/crates/cli/src/cli_args/fetch.rs).
- `pnpm_config_supported_architectures` with JSON overrides architecture policy
  for both fetch and install. `fetch --os` is unsupported, and dotted
  `--config.supportedArchitectures.*` overrides were silently ignored. Sandy
  gates the native override on tested pnpm major 12 and separates cache keys by
  policy and libc family. Agents and summaries disclose the verification limit.
- Registry metadata gets a dedicated disposable directory, removed before
  workspace copies. Installed dev and optional dependencies remain available.
- The complete inventory required by peer deny rules consists of distinct
  reserved roots. Copies can be populated on admission and released after each
  Agent finishes, while empty roots remain until shutdown. With a cap of two,
  the measured native seed plus two copies would occupy about 5.781 GiB.
  This is a size projection, not a measured Graindevue Actions run.
- Capacity preflight budgets ordinary copies and 1 GiB per admitted Agent for
  build/output headroom. It can reduce parallel concurrency or select serial
  execution before copying. ENOSPC/EDQUOT before admission retains safe serial
  fallback; later failures retain partial-review semantics.
- The issue-comment jobs used cache mode `read`. The hardened caller template
  explicitly grants job-level `cache-mode: write`; `actions: write` is unrelated.
  Only validated download snapshots captured before reviewed lifecycles are
  published. Mutable framework sources are restored without a post-review save.
  See [GitHub's cache policy](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode).
- Posted summaries include requested/effective execution, storage and cache
  outcomes, and bounded sanitized preparation failures. Token actions use
  `client-id`, with an optional client-ID secret and legacy numeric JWT issuer
  fallback. Node 20 action pins are replaced by Node 24 releases.

Using production copy timing to claim an exact free-space margin would be
unreliable: partial cleanup contributes to elapsed time. Preflight now measures
available space directly. There is no evidence here that a 16 GiB RAM VM is
required, nor a guarantee that every repository fits the standard runner.

## Validation and rollout

Regression fixtures exercise the actual pinned pnpm 12 CLI: foreign optional
packages install under the repository's broad policy, disappear under Sandy's
native policy, and cause zero foreign downloads. A second frozen installation
restores the validated snapshot with zero package downloads. Native Codex
0.162.0 fixtures test two concurrent Agents followed by a third, including
denials against both future empty peer roots and retired peer roots.

Existing caller repositories must copy the updated review workflow to their
default branch and advance their audited `SANDY_REF` after maintainer review.
Merging Sandy alone cannot change the caller's cache policy. Full repository CI
and a new Graindevue review remain rollout validation.
