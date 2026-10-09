# Review runtime evidence and rollout gate

Issue [#4](https://github.com/Graindevue/sandy/issues/4) adds download reuse, private Agent workspaces and an opt-in managed runtime. **Serial remains the default.** The exact-pin Linux compatibility gate passed; dedicated login refresh/writeback and adjudicated real-model latency/quality results are still pending. There is no measured production speedup or quality claim in this report.

| Evidence | Result | What it establishes |
| --- | --- | --- |
| Linux x64, Codex 0.162.0, credential-free native probe | [Passed CI](https://github.com/Graindevue/sandy/actions/runs/37929803123/job/113817459048) | Concurrent turns and reversed event routing; usage attribution; cancellation and drained shutdown; private workspace/HOME/TMP writes; credential and peer denial; read-only seed, siblings and Git metadata; untrusted reviewed config. |
| macOS arm64, same exact executable, local probe | Passed | The same mechanical probe on the local platform, with actual sandboxed tools and a controlled Responses provider. |
| Native managed and serial adapter probes | Passed locally | Actual Node cwd/realpath, copied dependency resolution, private tool writes, peer/auth denial and seed/shared-temp write denial through the public adapters. Provider output was controlled. |
| Shipped dependency cache adapter, actual Linux Actions provider | [Passed CI](https://github.com/Graindevue/sandy/actions/runs/37935720559/job/113837137172) | Save, remove and restore of a harmless download fixture through the real provider, with identical-byte verification. It does not measure reviewed lifecycles or model speed. |
| Fixture verification and report tests | Passed locally | Authored defects and clean revisions behave as specified with installed Zod 4.1.12; report math, missing metrics, aggregation and critical-severity gates work. These checks do not measure model quality. |
| Dedicated test login refresh and writeback | Pending | Needs the isolated test environment described in [the setup guide](../setup/review-benchmark.md). |
| Repeated, adjudicated real-model serial/parallel runs | Pending | Needs that test login and human evaluation of retained Findings. |

The probe is reproducible with `node scripts/codex-compatibility-probe.mjs /path/to/codex report.json`. It requires `codex-cli 0.162.0`, uses a local provider without authentication, has a 90-second bound and retains only bounded assertions. The separate Linux CI job installs bubblewrap and its dedicated AppArmor profile, passes no model/auth secrets and uploads `codex-compatibility.json`. Mock Responses usage proves attribution and parsing; it is not real token billing, auth refresh, model reasoning or latency evidence.

## Run a bounded live evaluation

Use the private caller workflow and explicit dedicated test home from [the setup guide](../setup/review-benchmark.md). Its test auth stream must be locked for the whole run and latest credentials loaded after admission. Build only the trusted packages; no Convex deployment or production posting is involved:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @sandy/shared-types --filter @sandy/manifest-builder --filter @sandy/bot-worker build
node scripts/review-benchmark.mjs run \
  --ci-home "$CODEX_HOME" --out "$RUNNER_TEMP/results.json" \
  --repetitions 1 --cases defects,clean --timeout-minutes 60 \
  --agent-timeout-seconds 300 --require-auth-refresh
```

`--ci-home` is mandatory even when `CODEX_HOME` is set. The canonical interactive Codex home and a symlinked auth file are refused. `--codex /path/to/codex` is optional; the selected executable must report exactly 0.162.0. Cases may be `defects`, `clean` or `defects,clean`; repetitions are bounded to 1–3, aggregate timeout to 1–90 minutes and each admitted Agent to 1–600 seconds. The default two-case smoke has 24 Agent runs, each with at most one bounded recovery turn; the maximum is 72 Agent runs. SIGTERM/SIGINT and deadline aborts drain the runtime before roots are removed. A teardown failure retains roots until quiescence can be established.

The refresh flag captures dedicated test `auth.json` evidence without modifying it, then asks the managed native owner to refresh through `account/read` with `refreshToken: true` before the first parallel sample's Agent admissions. An old `last_refresh` alone does not force a refresh when the access JWT remains valid. Native refresh has a 60-second bound; its owner is terminated on timeout and reaped before shutdown completes. The gate requires persisted token rotation, a fresh timestamp and the same account; RPC success alone is insufficient. The only emitted auth measurement is `authRefreshObserved: true|false|null`; no token values or digests are emitted. An unmet required refresh fails before Agent admission and records fixed failure classifications. The caller must persist refreshed credentials after process shutdown, including on failure. Rotation alone does not establish successful environment-secret writeback; retain the caller's persistence result as separate operational evidence.

Private benchmark Agent failures retain fixed classifications and a sanitized native message/details excerpt, with original character lengths. Seed, post-refresh and current credentials and account identifiers remain in trusted memory for redaction; headers, JWTs, URLs, emails and long opaque spans are also removed before the 1024-character bound. Messages above 64KiB and unavailable auth captures withhold excerpts. Raw native stdout/stderr is excluded. These benchmark diagnostics do not change production logging or establish a causal diagnosis by themselves.

The capture is saved after each completed sample, with an exclusive adjacent `.jsonl` journal for partial-run recovery. An adjacent `.fixtures/` directory retains both Git bundles, the exact verified Zod tarball and integrity metadata so humans can inspect the actual pinned code after disposable roots are removed. Clone the bundles and check out the captured SHAs; the lockfile's local download URL belongs to the evaluation source, so inspect/extract the retained tarball rather than blindly running installs after the job. Output contains Findings and fixture judgments but no raw runtime transcript or auth. Keep raw capture/adjudication artifacts private; the public repository receives only a reviewed summary. Give each run a fresh output path. The harness denies the output/journal/evidence directory, original fixtures, download snapshots, GitHub App key and CI command files to Agent tools.

## Fixed cases and measurements

Each job authors disposable, deterministically committed local Git repositories and pins base/head/sibling SHAs. It uses the shipped logic and security Agent definitions plus a fixed Zod-focused framework persona, all recorded with complete prompts, models and effort. All four cache/mode cells use the same roster, manifest, versions, targeted-test policy and review scope. These focused fixtures do not substitute for a future evaluation of every shipped framework persona on production-like repositories.

| Case | Ground truth |
| --- | --- |
| `defects`: negative transfer | P1 logic regression: a negative amount creates money. The existing passing test covers only positive transfers. |
| `defects`: tenant purge | P0 security regression: a non-operator authenticated member can clear every tenant's ledger. |
| `defects`: serialized profile | P1 framework regression: Zod passthrough preserves a password hash in an exposed response. Verify installed source before accepting the Finding. |
| `defects`: removed export | P1 cross-repo regression: the pinned sibling imports and calls the removed receipt export. |
| `clean` | Logging text change from the safe baseline; no expected defect. Actionable Findings require independent justification. |

Zod 4.1.12 is fetched from the [official registry](https://registry.npmjs.org/zod/4.1.12), checked against its published SHA-512 integrity and served by a bounded controlled local HTTP source. The fixture lockfile and exact host npm version are recorded. Cold samples start with a clean download store; warm samples restore an immutable snapshot primed outside the measured samples. npm first stages the frozen graph with scripts disabled to capture safe downloads, then performs the ordinary fresh frozen installation and its lifecycles once per sample. The staging cost is included in download preparation and total elapsed time. The prepared tree is then copied into independent Agent workspaces. No installed dependency directory is restored as a download cache. The harness counts actual tarball requests and bytes at the controlled source; initial fixture acquisition, metadata traffic, unrelated tool downloads and model HTTP traffic are outside that counter. Cache restore hits alone are not proof of download savings.

Capture fields include preparation, installation, cache restore/save, workspace materialization, runtime startup, investigation, shutdown and synthesis durations; per-Agent admission/queue times; actual download counters; seed and copied file lengths/allocated blocks; authoritative usage; observed tool activity; roster participation and partial outcomes. Posting is `null` because the harness never posts. Logical copy bytes quantify duplicated content; allocated block totals can double-count shared copy-on-write extents and are not an exclusive physical-disk measurement. There is no install repetition per Agent.

Absent protocol metrics remain `null`, including serial tool counts and managed activity when the pinned protocol omits tool completion. Cache-read, cache-creation, uncached input and output tokens remain separate. Do not infer zero tools from an omitted counter or estimate token usage from text. The report retains per-Agent metrics and summarizes measured wall/phase durations with counts, medians and nearest-rank p95; concurrent tool duration sums are not wall time.

## Adjudicate and combine matched runs

Run three separate identical two-case smoke jobs if three repetitions cannot fit one job. The capture digest excludes repetition count and case selection but includes actual pins, platform/Node, package manager, roster/prompt/model/effort, scope and deadlines. Reports reject changed configurations for a given fixture and changed expected judgments. Unique sample IDs stay unchanged when repetition numbers are combined. Include both cases and all cold/warm serial/parallel cells in each repetition; a subset or one smoke is never sufficient for promotion.

A human reviewer supplies one judgment record per sample, including clean samples with an empty Findings list. Every Finding needs exactly one entry identified by its actual Agent and zero-based index:

```json
[
  {
    "sampleId": "copy-the-actual-capture-id",
    "reviewer": "named human reviewer",
    "findings": [
      {
        "agentKey": "security",
        "findingIndex": 0,
        "defectId": "tenant-purge-auth",
        "actionableFalsePositive": false,
        "correctSeverity": true,
        "correctProducer": true,
        "verifiedInstalledSource": false
      }
    ]
  }
]
```

Use `defectId: null` for an unmatched Finding and independently decide whether it is an actionable false positive. Accept the framework defect only after checking that its evidence actually verifies the installed version's source; set `verifiedInstalledSource` accordingly. Judge severity and producer from the captured Finding, rather than the model's self-reported confidence. A downgraded P0/P1 does not count as the expected critical defect even if a judgment flag is accidentally true.

```bash
node scripts/review-benchmark.mjs report \
  --samples run-1/results.json --samples run-2/results.json --samples run-3/results.json \
  --adjudication judgments.json --operational-evidence operations.json --out report.json
```

`operations.json` contains `linuxCompatibility`, `dedicatedAuthRefreshWriteback` and `failureSemantics` booleans. Supply `true` only with linked actual evidence of the exact reviewed runtime and caller, including refreshed secret persistence and deadline/cancellation, partial failure, deterministic producer/order and no replay behavior. These inputs are reviewer assertions, not cryptographic attestations. The passed mechanical Linux probe can support its compatibility field; it cannot support live refresh or quality fields.

The report compares cold and warm serial/parallel counts, medians, p95 and absolute/percentage differences. It preserves separate P0/P1/P2 recall, actionable false positives, failure counts, complete roster participation, severity/producer attribution, installed-source verification and truthful partial outcomes. Promotion requires at least three complete matched repetitions, all case coverage, complete human adjudication, no missed parallel P0/P1, no recall/false-positive/failure regression, lower actual cold and warm median latency, and every operational gate. Synthetic unit-test samples always fail the live-evidence gate. Confidence scores do not waive quality gates. Until all of this evidence exists, keep the deployed concurrency cap at one.
