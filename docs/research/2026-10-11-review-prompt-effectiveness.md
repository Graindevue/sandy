# Review prompt effectiveness — 2026-10-11

Scope: localized edits to all seven shipped `agents/` prompts, preserving their
structure, voice, and exact runtime frontmatter. The proposed text is the PR
diff; each replacement and its token cost is recorded below.

The active baseline is `Graindevue/sandy` main at `c8713de`. The historical
source repository is archived. The active main already incorporates the
[2026-10-09 guidance audit](2026-10-09-agent-guidance-audit.md), including Codex
native tools, exact-version source checks, corrected framework assumptions,
and shared severity/confidence gates. Preserve those fixes; avoid replaying the
older proposal over the migrated runtime. `AGENTS.md` already targets `main`;
remove its remaining stale-branch mention as requested.

## Original instructions and remaining friction

### Logic

- Reviews logic/invariants and generic React correctness, traces callers and
  base behavior, and verifies candidates using targeted tests and installed
  source. Keep those specialist boundaries.
- Its caller/source instructions repeat details supplied in the shared contract.
  React's `use` exceptions and request-scoped cache distinction are useful seeds,
  rather than filler; preserve them in shorter wording.
- The output applies common severity/confidence rules but does not disambiguate
  the pseudo-JSON enum specimen or explicitly report incomplete investigations.

### Security

- Checks changed trust boundaries, sink safety, resource authorization,
  disclosures, and partial failure. Preserve its concrete attack-path analysis
  and corrected interpreter/cache examples.
- Source verification is repeated in three places; “confidence threshold below”
  points to a local scale that has moved to the shared runtime. Internal IDs or
  URLs need a concrete disclosure consequence, rather than inherent sensitivity.
- The local P0 floor repeats the shared rule. Its output still says “same format”
  without enum-selection, empty-search, or failed-check guidance.

### Convex

- Reviews functions, schema/indexes, consumers, transaction/retry boundaries,
  migrations, subscriptions, and client contracts. Preserve the already-correct
  action/nested-transaction, retry, and query-consistency distinctions.
- Method and investigation repeat consumer, schema/auth, and source reads.
  Prefer a shared search/source pointer plus an explicit migration evidence target.
- The evolving-framework and seed-authority preambles overlap the shared
  evidence/source contract. Output needs the same small clarification as peers.

### Next.js

- Reviews version/configuration, caching, routing, metadata, actions, and server
  boundaries. Preserve workspace resolution, bundled version-matched docs,
  cache lifetimes/private caches, and alternate valid freshness mechanisms.
- “Ownership checks” is narrower than the app's actual resource authorization:
  roles or capabilities can grant legitimate access. “Suspicious” server
  mutations and API-oriented invalidation wording need an actual failure target.
- Source-suppression and cross-app search repeat the shared contract; common
  output handling can use a short explicit instruction instead of vague parity.

### i18n

- Checks effective message resolution, fallback/merging, dynamic keys,
  namespaces, caller values, and locale-specific plurals. Keep those corrections;
  raw file parity and missing literal matches do not establish failure.
- Manifest/key/source reads repeat the review method and shared version contract.
  Source verification is mandatory even for familiar libraries.
- Locale formatting assumes Biome, although the reviewed Repo may use another
  tool. Seeds should require a resolution failure or translation convention;
  output should explain enum selection and incomplete checks.

### Style

- Reviews maintenance costs beyond the reviewed Repo's enabled tooling, follows
  local conventions, caps findings at P2, and requires confidence ≥4. Keep these
  specialty constraints and the stronger gate.
- Activation narration repeats frontmatter/selector policy. Pattern disclaimers
  and DRY/naming/comment caveats overlap and can be compressed.
- “WHAT versus WHY” comments invite blanket criticism despite contextual value.
  Require concrete readability cost and preserve intent/constraint comments.

### Test coverage

- Reviews risky changed behavior across test layers, requires branch/path
  coverage or an executed counterexample for execution-dependent claims, and
  permits directly proven static defects. Preserve all these evidence limits.
- Its focused-test step repeats the supplied toolchain's setup and suite-reuse
  rules. Its coverage step can shorten wording while retaining target-file
  evidence, isolated/restored edits, and command/scope/result reporting.
- The assertion recommendation earns its place; separate that specialty goal
  from common output formatting without adding another section. Keep the
  correct `convex-test` limits and non-production test-environment guidance.

## Current primary-source guidance

OpenAI's current GPT-6 guide favors clear outcomes, proportionate focused
verification, and prompts evaluated on the chosen model/workload. Its prompting
observations are based on Astra; they are guidance, not measured improvements on
Sandy's GPT-6.1 Sol. The model page supports the existing `xhigh` setting; no
model or effort migration is justified by this task.
[Prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices),
[verification guidance](https://developers.openai.com/api/docs/guides/latest-model#testing-and-verification),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

OpenAI's retained GPT-5.6 section advises removing repetitions and preserving
examples that encode product requirements. Its reasoning guidance favors simple,
direct prompts, zero-shot first, and no requests for chain-of-thought. Keep
concise domain seeds; lengthy sample reviews and extra reasoning rituals have
no demonstrated local failure to fix.
[Leaner prompts](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#favor-leaner-prompts),
[reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices#how-to-prompt-reasoning-models-effectively).

The Codex review rubric requires discrete, newly introduced, actionable bugs
with concrete affected scenarios. Use that evidence discipline while retaining
Sandy's authorized style/test scope.
[Pinned Codex rubric](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/prompts/templates/review/rubric.md).

Framework corrections already present in main remain relevant: Convex has
context-dependent transaction boundaries and official mock testing; Next.js
cache keys and time-based refresh can satisfy valid isolation/freshness; i18n
fallback and differing plural categories can be intentional. These sources
support keeping the corrected seeds, not expanding the checklist.
[Convex boundaries](https://docs.convex.dev/understanding/best-practices#avoid-sequential-ctxrunmutation--ctxrunquery-calls-from-actions),
[convex-test](https://docs.convex.dev/testing/convex-test),
[Next.js caching](https://nextjs.org/docs/app/api-reference/directives/use-cache),
[i18next fallback](https://www.i18next.com/principles/fallback),
[next-intl plurals](https://next-intl.dev/docs/usage/translations#cardinal-pluralization).

## Runtime contract and dead weight

[The shared prompt](../../packages/bot-worker/src/worker/review-prompt.ts) supplies
the evidence gate, exact-version source verification, native toolchain
restrictions, Rule precedence, cross-repo search rules, severity, and confidence:
≥3 for Findings, ≥4 for P0, with stricter specialist gates. Reuse these contracts;
no new threshold is introduced. The style ≥4/P2 constraint remains local.

[The parser](../../packages/bot-worker/src/worker/findings-parser.ts) requires
valid JSON and search audits even for empty reviews. The shared specimen still
uses illustrative enum alternatives; “choose one value per enum” resolves that
ambiguity without copying the schema or changing the runtime. Optional `summary`
reports incomplete checks; it does not create a failed job or a new search state.
Preserve actual searched/skipped decisions instead of converting uncertainty
into a clean review.

[Selection](../../packages/bot-worker/src/worker/agent-selector.ts) and frontmatter
own activation. Delete redundant narration where it adds no review constraint.
Parallel-agent identity, repeated source/suppression steps, and overlapping
manifest/caller searches spend tokens without adding a contract. These are
structural duplication claims, not measured model-default ablations. Keep
specialist seeds, local conventions, source evidence, and the test agent's
execution limits: they encode product requirements.

## Length budget

Compare active main `c8713de` with this PR. Words use whitespace splitting.
Body counts exclude YAML frontmatter and trim surrounding whitespace, matching
the loaded system prompt. Tokens use `tiktoken` `o200k_base` as a reproducible
input-size proxy; they are not a billing estimate. Counts exclude the shared
runtime suffix and this research note.

| Prompt | Full-file words before → after | Body words before → after | Full-file proxy tokens before → after | Body proxy tokens before → after |
| --- | --- | --- | --- | --- |
| `agents/convex.md` | 718 → 667 | 686 → 635 | 1018 → 950 | 948 → 880 |
| `agents/i18n.md` | 548 → 485 | 519 → 456 | 798 → 705 | 731 → 638 |
| `agents/logic.md` | 379 → 346 | 354 → 321 | 520 → 501 | 460 → 441 |
| `agents/nextjs.md` | 692 → 640 | 663 → 611 | 973 → 903 | 909 → 839 |
| `agents/security.md` | 643 → 565 | 616 → 538 | 921 → 825 | 865 → 769 |
| `agents/style.md` | 408 → 335 | 379 → 306 | 557 → 471 | 495 → 409 |
| `agents/test-coverage.md` | 520 → 493 | 488 → 461 | 687 → 670 | 625 → 608 |
| **Total** | **3908 → 3531** | **3705 → 3328** | **5474 → 5025** | **5033 → 4584** |

Net: **-377 words** (9.6% shorter), **-449 proxy tokens**. Every prompt is shorter in both measures.

## Per-change rationale and token cost

Rows correspond to localized replacements in the PR diff. Negative token deltas
save input tokens; positive deltas add them. Successive whole-file measurements
include tokenizer boundary effects and reconcile exactly to each final file.

| Prompt / change | Why | Proxy token delta |
| --- | --- | ---: |
| `AGENTS` / Remove stale branch hint | Main already is the feature and PR base; removes the stale branch mention as requested. | -33 |
| `convex` / Role and diff scope | Removes parallel-review narration and makes the specialist scope explicit. | -8 |
| `convex` / Checklist preamble | The non-exhaustive seeds and mandatory installed-source contract already establish this rule. | -14 |
| `convex` / Source contract duplication | Retains the mandatory shared verification/suppression contract without repeating its details. | -41 |
| `convex` / Priming preamble | Keeps useful failure families while tying them to the authoritative evidence standard. | -11 |
| `convex` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +39 |
| `convex` / Investigation duplication | Removes repeated method reads and gives migration claims a concrete evidence target. | -33 |
| `i18n` / Role and diff scope | Removes parallel-review narration and makes the specialist scope explicit. | -8 |
| `i18n` / Source verification | Keeps structural/library evidence distinct while delegating version/source mechanics. | -31 |
| `i18n` / Priming preamble | Prevents speculative literal-string advice while retaining the shared evidence gate. | -12 |
| `i18n` / Investigation duplication | Removes manifest/search steps already in the method while preserving cross-repo translation contracts. | -51 |
| `i18n` / Repeated version lookup | The mandatory shared source contract already resolves exact versions regardless of familiarity. | -33 |
| `i18n` / Formatter scope | Limits the exclusion to locale-file syntax and follows the reviewed Repo’s actual tooling rather than assuming Biome. | +3 |
| `i18n` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +39 |
| `logic` / Role and diff scope | Keeps React ownership and specialist separation while making the diff boundary explicit. | -2 |
| `logic` / Caller tracing | Keeps consequential investigation and delegates search triggers to the existing shared contract. | -13 |
| `logic` / Candidate verification | Retains required version verification while removing repeated phrasing. | -7 |
| `logic` / React context | Preserves the useful hook-exception/cache priors and delegates general version lookup to the shared contract. | -13 |
| `logic` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +16 |
| `nextjs` / Role and diff scope | Removes parallel-review narration and makes the specialist scope explicit. | -8 |
| `nextjs` / Checklist preamble | The non-exhaustive seeds and mandatory installed-source contract already establish this rule. | -14 |
| `nextjs` / Source contract duplication | Retains the mandatory shared verification/suppression contract without repeating its details. | -20 |
| `nextjs` / Priming preamble | Keeps useful failure families while tying them to the authoritative evidence standard. | -8 |
| `nextjs` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +39 |
| `nextjs` / Freshness seed | Focuses on the actual freshness contract instead of implying particular API usage is required. | -23 |
| `nextjs` / Resource authorization | Aligns with legitimate ownership, tenant, role, and capability permissions in the security contract. | -6 |
| `nextjs` / Rendering seed | Replaces suspiciousness with a concrete failing operation. | -1 |
| `nextjs` / Cross-app investigation | Keeps cross-app scope without repeating the shared trigger/search mechanics. | -29 |
| `security` / Role and diff scope | Removes parallel-review narration and makes the specialist scope explicit. | -13 |
| `security` / Sensitive disclosure | Avoids treating every internal identifier/URL as sensitive without a disclosure consequence. | -7 |
| `security` / Source evidence | Keeps mandatory source verification and removes duplication plus a dangling reference to a local threshold. | -70 |
| `security` / Investigation duplication | Delegates source/search policy while retaining the distinction between new issues and existing patterns. | -29 |
| `security` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +36 |
| `security` / Shared confidence gate | Removes a duplicate P0 threshold and suppression rule already supplied to every Agent. | -13 |
| `style` / Role and diff scope | Keeps actual target-repo tooling authoritative; the review method already requires reading its configuration. | -24 |
| `style` / Activation narration | Leaves activation in frontmatter and the selector instead of repeating it in the persona. | -26 |
| `style` / Evidence criterion | Replaces repeated pattern disclaimers with a checkable finding criterion. | -19 |
| `style` / Comment seed | Avoids blanket WHAT/WHY judgments when a comment provides useful context. | +0 |
| `style` / Local caveats | Retains the important exceptions while trimming overlapping examples and repetition. | -49 |
| `style` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +39 |
| `style` / Severity wording | Preserves the stricter style gate and references the authoritative score definitions. | -7 |
| `test-coverage` / Role and activation | Keeps the role and optional scope; the method already requires reading the supplied suite result. | -12 |
| `test-coverage` / Focused execution | Preserves conditional execution and suite reuse while delegating repeated setup restrictions. | -17 |
| `test-coverage` / Coverage evidence | Keeps executed coverage/counterexample evidence and edit restoration while removing redundant prose. | -16 |
| `test-coverage` / Output and incomplete review | Clarifies valid enum selection, preserves actual empty-review search audits, and reports incomplete checks in an existing field. | +14 |
| `test-coverage` / Assertion recommendation | Preserves the specialist actionable-assertion requirement outside the common output formatting. | +14 |

## Rejected additions and practical limits

Reject long few-shot reviews, chain-of-thought/self-debate steps, mandatory fixes,
expanded checklists, generic vigilance/safety boilerplate, new error fields,
and model/effort changes. Keep conditional focused tests rather than mandate an
executed reproduction for every claim. Adding local confidence rubrics would
repeat and potentially conflict with the current shared definitions.

These edits are source-grounded hypotheses. Smaller inputs and parser-compatible
output do not prove improved precision, recall, latency, or total execution cost.
No model-based benchmark was run. A paired review set with known bugs, clean
changes, valid caches, intentional fallback, appropriate mocks, and unavailable
context would be the next meaningful quality measurement. No live/private
repository data is included here.

## Validation

- Full repository type-check passes. Full tests: 51 files passed, 549 tests
  passed, 2 skipped. The shipped-agent test loads the actual edited files.
- `pnpm lint` passes on a clean snapshot containing exactly the PR files; 190
  files checked, no diagnostics. Previous untracked research artifacts are
  excluded from the PR. `git diff --check` passes.
- All original headings and YAML frontmatter match exactly. Every persona is
  shorter in full-file/body words and proxy tokens; the edit ledger reconciles
  to the final files. Shared runtime behavior and thresholds are unchanged.
