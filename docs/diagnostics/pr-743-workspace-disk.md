# PR #743: Security workspace exhausted the runner's disk

Investigated 2026-10-10. The failed caller used Sandy
`9a33d5a02931c37c963bfa87b8763a8d68797322`. The relevant copy and execution code
is unchanged on current `main` (`fc8dfff`).

## Observed failure

[Actions run 37996342832](https://github.com/Graindevue/graindevue/actions/runs/37996342832)
reviewed Graindevue/graindevue PR #743 at
`17ef15cc5dcbb889721a88319566ef7f91127f6a` in parallel mode. Two Agents were
selected: logic and security.

| Phase | Outcome |
| --- | --- |
| Dependency preparation | Installed successfully in 108.315 seconds; download preparation was unavailable. |
| Logic workspace copy | Completed in 83.957 seconds. |
| Security workspace copy | Failed before Agent admission with `ENOSPC` while copying an installed `caniuse-lite` file. |
| Logic investigation | Completed in 108.384 seconds with zero Findings. |
| Review | Posted a partial summary; advisory Check Run was neutral, Actions workflow failed. |
| Codex auth persistence | Completed successfully after the failed review. |

The error persisted in Convex was:

```text
Agent workspace could not be prepared: ENOSPC: no space left on device,
copyfile '<SEED>/node_modules/.pnpm/caniuse-lite@1.0.30001791/node_modules/caniuse-lite/data/features/css-placeholder.js'
-> '<SECURITY_WORKSPACE>/node_modules/.pnpm/caniuse-lite@1.0.30001791/node_modules/caniuse-lite/data/features/css-placeholder.js'
```

The existing executor recorded this as a failed Agent Run and continued with
logic. Its phase logs omitted the setup error, so the failure only became
visible by inspecting Convex and the eventual partial summary.

## Reproduction and diagnosis

The initial loop called the real `CloneManager.materializeAgentWorkspace` on a
disposable 64 MiB HFS+ volume. A single 26,198,016-byte dependency file was the
entire prepared installation; no Git history, model request, cache, or earlier
workspace was needed. The first Agent copy succeeded, the second failed with
the same `ENOSPC`/`copyfile`/`node_modules` symptom. This repeated consistently.
Removing the first copy from the scenario let the second copy succeed.

Measurements on that fixture:

```text
Initial free bytes:          65,499,136
After prepared installation: 39,301,120
After first Agent copy:      13,103,104
Mandatory copy-on-write:     ENOSYS
Free inodes before copies:   4,294,967,270
Second Agent copy:           ENOSPC
```

`COPYFILE_FICLONE` requests copy-on-write but permits a regular-copy fallback.
`COPYFILE_FICLONE_FORCE` rejects unsupported cloning instead. This behavior is
documented in the [Node 24 filesystem API](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#fspromisescopyfilesrc-dest-mode).
Sandy's permissive flag therefore does not bound the allocation required for
each private installation. A prepared seed plus two full Agent copies requires
approximately three installations' worth of space, before tool outputs.

The ranked alternatives were full-copy block exhaustion, inode exhaustion, and
cache/leftover accumulation. The minimal reproduction confirms block exhaustion
without caches or leftovers and with plentiful inodes. The original Actions
run did not capture filesystem type, free blocks, or free inodes; its exact
disk distribution and clone support remain unmeasured. Full-copy amplification
is the supported explanation, rather than a claim that production's block and
inode counters were captured. GitHub documents only
[14 GB SSD storage for standard Linux runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Tested recovery

Before any Agent starts, workspace copying failures with `ENOSPC` or `EDQUOT`
now trigger removal of already prepared private copies and select a concurrency
cap of one. All Agents that have not independently failed preparation run on
the existing prepared installation, using the established serial runtime.
The failed partial copy is removed by `CloneManager` before its error reaches
the executor. The fallback is logged explicitly.

This preserves the complete roster for the reproduced capacity failure without
sharing mutable hardlinks across concurrent Agents, reinstalling dependencies,
or repeating investigations. Cleanup failure aborts the Review. Permission
errors, cancellation, and failures during active Agent execution retain their
failure behavior.

The same real-volume reproduction was tightened to exercise `ReviewExecutor`
and `CloneManager` together under Node 24.21.0, with a controlled runner that
records admission instead of calling a model. Before the fix, security was
recorded as failed and never started. After the fix:

```text
Private Agent workspace storage exhausted (ENOSPC); removing prepared copies and using serial mode.
Execution mode: serial (maximum 1 Agents).
logic: completed
security: completed
PASS: both reviewers completed, no partial review.
```

The disposable volume and temporary reproduction script were removed. The fast
permanent regression loop injects the OS capacity error at the actual executor
workspace-preparation call site:

```bash
pnpm exec vitest run packages/bot-worker/src/worker/review-executor-concurrency.test.ts
```

It checks failure on the first and second copy, quota exhaustion, cleanup before
runtime admission, complete Agent records, and preservation of ordinary failures.

Validation under Node 24.21.0 and pnpm 10.34.1 passed:

- `pnpm lint` and `pnpm type-check`.
- Builds of shared-types, manifest-builder, and bot-worker.
- The complete Vitest suite: 48 files, 496 tests passed, two existing skips.
- Actions helper tests: 29 passed.
- The real-volume executor replay described above.

The local global pnpm is 12.10.1 outside a pinned project. The cache test's
`current` case selects that version in its temporary directory and fails on
unchanged `main` too. The case and full suite pass when pnpm 10.34.1 is placed
on the child command path, matching CI. The full-suite verification command was:

```bash
npx --yes pnpm@10.34.1 test --silent --reporter=dot
```

## Operational application and limits

Until the updated Sandy revision is deployed through the caller's audited
`SANDY_REF`, setting caller variable `SANDY_AGENT_EXECUTION_MODE` to `serial`
avoids the copies entirely. This investigation did not change that production
variable, update the pin, or request another review.

Automatic recovery trades parallel investigation for complete serial coverage.
It still spends time attempting copies before the capacity error, and the
overall Review deadline remains in force. Keeping parallel execution for large
installations requires sufficient disk for independent copies or verified
copy-on-write storage. Shared mutable hardlinks would violate Agent isolation.
