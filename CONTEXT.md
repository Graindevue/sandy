# Sandy Domain Glossary

The vocabulary used by Sandy's review model. Deployment and execution choices
are recorded in [ADR 0018](./docs/adr/0018-github-actions-codex-runtime.md).

## Product

A named group of Repos that together form one software product. A Product scopes
cross-repo context, shared Rules, and historical learning data; each Repo belongs
to exactly one Product.

## Repo

A GitHub repository registered in a Product. Its default branch is the reference
against which sibling contracts are judged.

## Review

One requested assessment of a Pull Request by a set of Agents. It produces
Findings, a Confidence Score, and a Review Status Check for a specific PR head
commit. Its summary names that reviewed commit.

## ReviewJob

The durable record of one Review attempt. Its lifecycle is `pending` → `running`
→ `completed`, `failed`, or `superseded`; multiple attempts may exist for a PR.

## Review Status Check

The advisory GitHub Check Run named **Sandy**, showing a Review's progress and
outcome. Findings are advisory; an execution failure is reported as a failure,
and a partial review must not appear as a clean all-clear.
_Avoid_: CI check, commit status.

## Agent

A reviewer persona comprising a prompt, runtime selection, tool guidance, and
completion signal. It is configuration data; a Review can use several personas
without changing Sandy's implementation.

## Agent Runtime Override

An operator's replacement of an Agent's vendor, model, and optional reasoning
effort while keeping its persona. The replacement is complete: omitted effort
uses the runtime default rather than inheriting the persona's effort.
_Avoid_: custom Agent (which changes the persona).

## Agent Run

One Agent's execution within a Review, consuming quota and producing that
persona's Findings. Its Usage records input, cached input, and output tokens to
help manage subscription headroom.
_Avoid_: session, job (the ReviewJob is the durable attempt).

## Finding

One evidenced issue raised by an Agent. It has severity P0/P1/P2, confidence
0–5, a summary, evidence, and an anchor in the reviewed PR's diff; optional
cross-repo references identify affected consumers.

A cross-repo contract change produces one Finding with its confirmed consumer
references, rather than one Finding per consumer. Unpostable anchors fall back
to the PR summary; sibling references are evidence, not separate comments.

## Confidence Score

The Review's 0–5 assessment of the whole change: **5 means clean**, while severe
or numerous Findings lower the score. A Finding's confidence has the opposite
direction: a higher value means the Agent is more certain the issue is real.
_Avoid_: risk score.

## Rule

A human-authored guideline for review behavior, either Repo-local or shared by
the Product. Rules travel with the code and take precedence over a persona's
non-exhaustive seed examples.

## ApiSurfaceManifest

A per-Review description of the Product's public contracts and framework
versions at the reviewed and sibling revisions. It identifies what to search;
the actual source establishes who depends on a contract.

## Cross-Repo Search

An Agent's targeted search of sibling Repos for consumers affected by the PR.
It is warranted by a changed public contract or a plausible behavioral contract
risk, and its rationale is recorded even when the Agent decides to skip it.

Breaks are judged against sibling default branches, without reconciling their
in-flight PRs. References must be confirmed usages; coincidental text matches
are insufficient evidence. See ADRs [0010](./docs/adr/0010-cross-repo-access-via-mounted-sibling-worktrees.md),
[0011](./docs/adr/0011-cross-repo-breaks-judged-against-sibling-main.md), and
[0012](./docs/adr/0012-cross-repo-findings-post-on-the-producer-pr.md).

## Extractor

A component that derives one section of the ApiSurfaceManifest from a Repo.
Default and instance-specific Extractors contribute to the same manifest.

## Synthesizer

The deterministic consolidation of Agent Findings into a deduplicated, scored,
ordered Review result. It preserves cross-repo evidence and formats the comment
set and summary.

## Review trigger

A newly created PR comment containing standalone `@sandy`, authored by an
authorized human collaborator with repository write access. This is the sole
request path. After new commits, the author posts a new `@sandy` comment to
request a Review of the current head; earlier summaries still describe their
named reviewed commits.

## Archetype

A historical cluster of semantically similar Findings within a Product and
Agent, carrying a suppression weight. New Archetype assignment is disabled in
the Actions runtime.

## Reaction

A human's positive or negative feedback, reply, or inferred merge-state signal
associated with a Finding. Collection is reserved for a future feedback job.

## SuggestedRule

A candidate Rule inferred from recurring feedback, awaiting a human decision
before promotion. Historical SuggestedRules remain stored; automatic promotion
is inactive in the Actions runtime.

## Comment Trailer

The hidden identifier that associates a posted comment with its Finding. The
current trailer is `<!-- bot:finding=<id> -->`; historical learning-enabled
comments may also carry `archetype=<id>`.
