# TASK

You are the local quality gate for branch `{{BRANCH}}` before it is autonomously
merged into `{{TARGET_BRANCH}}`. Run a **thermo-nuclear code-quality review** of
the change, then improve its structure, abstraction quality, and maintainability
— while preserving exact behavior.

Be ambitious. Do **not** stop at local cleanup. Hunt for "code-judo" moves:
restructurings that preserve behavior while making the implementation
dramatically simpler, smaller, and more direct. Prefer deleting complexity over
rearranging it.

But calibrate that ambition to where you are: this is a single autonomous pass,
and the only automated gate before `{{TARGET_BRANCH}}` is `pnpm type-check` +
`pnpm test`. So every change you make must keep behavior identical and the gate
green. **Ambition is about structure; behavior is sacred.**

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

Read `AGENTS.md` and the domain glossary in `CONTEXT.md` before you judge
anything — Sandy's vocabulary is load-bearing, and "cleanups" that blur it cause
the exact architectural drift this review exists to prevent. Use targeted
discovery (`rg`, narrow ranges) over whole-file dumps.

# THE BAR

Start from this baseline:

> Perform a deep code-quality audit of this branch's changes. Rethink how the
> change could be structured to meaningfully improve quality without affecting
> behavior — better abstractions, more modularity, less spaghetti, more succinct
> and legible code. If there is a clear path to a simpler implementation that
> means restructuring some of the touched code, take it. Be thorough and
> rigorous. Measure twice, cut once.

Then hold these non-negotiable standards:

0. **Be ambitious — find the code-judo move.** Look for the reframing that makes
   whole branches, helpers, modes, flags, or layers *disappear*, not just get
   centralized. Assume a restructuring that uses the existing architecture more
   effectively is often available — find it. The best fix makes the change feel
   inevitable in hindsight.
1. **Don't let this branch push a file from under 1000 lines to over 1000.**
   Treat that as a strong smell. Extract helpers, subcomponents, or modules
   instead of letting a file sprawl. If the diff crosses 1000 lines in a file,
   decompose it as part of this review unless there is a compelling structural
   reason and the result is still clearly organized.
2. **Don't allow spaghetti growth.** Be hostile to new ad-hoc conditionals,
   scattered special cases, and one-off branches bolted into unrelated flows.
   "Weird if-statements in random places" is a design problem, not a nit. Push
   the logic into a dedicated helper, a typed dispatch, or the module that
   already owns the concept.
3. **Clean the design — don't rubber-stamp working code.** If behavior can stay
   identical while the structure gets meaningfully cleaner, make it cleaner.
   Prefer removing moving pieces over spreading the same complexity around. "It
   works" is not the bar.
4. **Direct and boring beats clever and magical.** Distrust generic mechanisms
   that hide simple data-shape assumptions. Flag thin wrappers, identity /
   pass-through helpers, and abstractions that add indirection without buying
   clarity. Replace nested ternaries with `switch` / `if`-`else`; delete
   comments that only restate the code.
5. **Tighten types and boundaries.** Question needless optionality, `unknown`,
   `any`, and cast-heavy code where a clearer type or shared contract would make
   the control flow simpler. If a branch leans on a silent fallback to paper over
   an unclear invariant, make the boundary explicit instead.
6. **Keep logic in its canonical layer; reuse what exists.** Sandy is a
   focused-package monorepo (`packages/*`) with named concepts — Extractors live
   in `extractors/`, post-processing belongs to the Synthesizer, the Apple
   Container provider lives in `packages/apple-container-provider` (ADR 0009),
   Convex code in `packages/convex-backend/convex/`. Call out feature logic
   leaking into shared paths and implementation details leaking through an API.
   Prefer the existing canonical helper over a near-duplicate; push code to the
   package that already owns the concept rather than normalizing drift.
7. **Prefer atomic state and sane concurrency.** In Convex, keep related writes
   inside one mutation rather than across calls that can leave state half-applied
   (e.g. ReviewJob status transitions, Finding / Archetype persistence). If
   clearly independent work is serialized for no reason, parallelize it — but
   don't chase micro-optimizations; only flag orchestration that genuinely makes
   the code more brittle.

As you read each meaningful change, ask: Is there a code-judo move that makes
this dramatically simpler? Can it be reframed so fewer concepts / branches /
helper layers are needed? Did a cohesive module become more coupled or harder to
scan? Is this logic in the right package and layer? Is this abstraction earning
its keep, or is it just a wrapper?

# SANDY INVARIANTS — DO NOT "SIMPLIFY" THESE AWAY

An ambitious refactor must not break what is deliberately load-bearing:

- The **Comment Trailer** (`<!-- bot:finding=<id> archetype=<id> -->`) is
  load-bearing — never remove or "tidy" it away.
- **Agents are configuration data** (markdown in `agents/` / `.config/agents/`),
  not code. Do not refactor them into code or assume adding one needs a code
  change.
- `packages/convex-backend/convex/_generated/` is **generated output** — never
  hand-edit it; regenerate via codegen.
- The **vocabulary in `CONTEXT.md`** (Product, Repo, Review, Finding, Agent,
  Extractor, Synthesizer, …) is load-bearing — don't rename or blur it into
  vaguer terms.

# FLAG AND FIX ON SIGHT

- A complicated implementation where a cleaner reframing would delete whole
  categories of complexity.
- A refactor that moves code around without reducing the concepts a reader must
  hold in their head.
- A file crossing 1000 lines because of this branch.
- New conditionals bolted onto unrelated paths; one-off booleans, nullable modes,
  or flags that complicate existing control flow.
- Feature-specific logic leaking into a general-purpose module.
- "Magic" handling that hides simple structure; thin wrappers / identity
  abstractions that add indirection without simplifying anything.
- Needless casts, `any`, `unknown`, or optional params that obscure the real
  contract.
- Copy-pasted logic instead of an extracted helper; a bespoke helper where a
  canonical one already exists.
- Narrow edge-case handling buried in the middle of an already-busy function.
- "Temporary" branching that will quietly become permanent debt.
- Non-atomic Convex writes, or needlessly sequential independent work.

# PREFERRED MOVES

- Delete a layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting
  centralized; turn special cases into a simpler default flow with fewer
  exceptions.
- Extract a pure helper; split a large file into focused modules.
- Replace condition chains with a typed model or an explicit dispatcher.
- Separate orchestration from business logic; collapse duplicate branches into
  one clearer flow.
- Move logic to the package/module that already owns the concept; reuse the
  canonical helper instead of a near-duplicate.
- Make a type boundary explicit so the control flow gets simpler.
- Keep related updates in one atomic mutation; parallelize genuinely independent
  work when that also simplifies the flow.

Do not settle for "maybe rename this" when the real issue is structural, and do
not settle for a cleaner version of the same messy idea when a much simpler idea
is in reach.

# REVIEW PROCESS

1. **Understand the change** — read the diff and commits above and the intent
   behind them.
2. **Hunt for the code-judo move first** — before touching anything, ask what
   single restructuring would delete the most complexity while preserving
   behavior. Design the cleanup, then make it.
3. **Check correctness & security** — does the implementation match intent and
   handle edge cases? Are new/changed behaviors covered by tests? Any unsafe
   casts or `any`? Any injection, credential/secret leak, or other security
   issue? Sandy handles GitHub App tokens and runs over untrusted PR code, so
   treat secret handling and command construction with care.
4. **Apply project standards** — follow @.sandcastle/CODING_STANDARDS.md (Biome
   enforces formatting/lint; prefer named exports; match surrounding
   conventions).
5. **Apply Convex standards** — for changes under
   `packages/convex-backend/convex/`, follow
   `packages/convex-backend/convex/_generated/ai/guidelines.md` and
   `packages/convex-backend/README.md`.
6. **Verify framework behavior at the source** — when Convex / Next.js / React
   behavior is load-bearing to a restructuring and local types/docs/errors don't
   settle it, follow @.sandcastle/OPENSRC.md to read the installed version's
   source. Ambition is licensed by verification: confirm, don't assume.
7. **Preserve behavior exactly** — change only *how* the code works, never *what*
   it does. Every output, feature, and externally observable behavior stays
   identical.

# EXECUTION

The sandbox setup hook has already run `CI=true pnpm install --frozen-lockfile`
to create Linux-native dependencies. Do not run `pnpm install` yourself unless
dependency setup clearly failed; report dependency setup failures instead of
trying to repair `node_modules` interactively.

If you find improvements to make:

1. Make the changes directly on branch `{{BRANCH}}`.
2. If you restructure, make sure tests still cover the behavior you are
   preserving — extend or add a focused test where coverage is thin and cheap to
   add. Do not start overlapping long-running commands; wait for one check to
   finish before starting another.
3. Run `pnpm type-check`, `pnpm test`, and `pnpm lint` (`pnpm lint:fix` to
   auto-fix formatting). All must pass — this is the only automated gate before
   `{{TARGET_BRANCH}}`.
4. Commit describing the refinements: Conventional Commits (subject starts with
   `feat:` or `fix:`), no AI co-author / "generated by" footers.

When a high-value restructuring is too large or too risky to land **safely** in
this single pass — broad blast radius, thin test coverage, or any doubt about
behavior preservation — make the largest safe, verifiable subset now and note the
remaining opportunity in the commit body so the human sees it on the
`staging`→`main` review. Never merge a refactor you cannot verify.

If the code is already clean and well-structured, do nothing — but hold a high
bar for "clean." Leaving the branch untouched is only justified when there is no
structural regression, no visible code-judo move left on the table, no file-size
explosion, no new spaghetti branching, no hacky/magic abstraction, no needless
wrapper/cast/optionality, and no canonical-helper duplication or layer leak. If
any of those are present and safely fixable, fix them.

Once complete, output <promise>COMPLETE</promise>.
