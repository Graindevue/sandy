import type { ReviewBotContext } from '../config/review-bot-context.js';
import type { RunAgentInput } from './codex-exec-runner.js';
import type { DependencyInstallResult } from './dependency-install.js';

const AGENT_PRIOR_CONTRACT = `

Agent priors and active Rules:
- Treat Agent-specific examples in the system prompt as non-exhaustive seed knowledge, not as a complete checklist.
- Product Rules and Repo-local Rules in this prompt are active, version-controlled instructions for this Review. If an active Rule conflicts with a seed example, follow the Rule.
- If a Rule and a seed example point at the same issue, emit at most one Finding and cite the strongest concrete evidence.`;
const SOURCE_VERIFICATION_CONTRACT = `

Framework source verification:
- Do not fetch dependency source preemptively. First inspect the diff, local code, ApiSurfaceManifest, and available local types/config.
- Before emitting a Finding whose correctness depends on framework or library behavior, verify that behavior against the installed version's source with opensrc. Local types/config can guide the search, but training memory or type-shape guesses do not prove runtime behavior.
- Useful pattern: run \`opensrc path <package>\`, then search the returned source path for the touched API or symbol with \`rg\`.
- Record the verification in the Finding.evidence: package name, installed version from the ApiSurfaceManifest when available, source path or symbol inspected, and the behavior confirmed.
- Memory or generic training knowledge is not evidence for a framework-behavior claim. If installed source contradicts the suspicion, or you cannot verify enough for the Finding's confidence, suppress the Finding.`;
const TOKEN_DISCIPLINE_CONTRACT = `

Token discipline:
- Prefer locating symbols with search (\`rg\`) before opening files, then read only the relevant matches.
- Prefer reading focused line ranges over whole files when a range is enough to verify behavior.
- Prefer running the narrowest relevant test first, then broaden only as needed.
- Avoid pasting full command logs into your output. Summarize noisy logs, but preserve exact file paths, line numbers, and error text needed to support Findings.`;

export function buildReviewPrompt(input: RunAgentInput): string {
  const pr = input.pullRequest;
  const siblingContext =
    input.siblingWorktrees === undefined || input.siblingWorktrees.length === 0
      ? ''
      : `
Sibling Repo worktrees:
${input.siblingWorktrees
  .map((sibling) => `- ${sibling.hostPath} -> ${sibling.repo} @ ${sibling.sha}`)
  .join('\n')}
`;
  const manifestContext =
    input.apiSurfaceManifest === undefined
      ? ''
      : `
API Surface Manifest context:
Use this manifest as a trigger for Cross-Repo Search. It lists public surface and framework versions only; it does not enumerate callers.

${input.apiSurfaceManifest.trim()}
`;
  const toolchainContext = formatDependencyInstallContext(input.dependencyInstall);
  return `${input.agent.systemPrompt}

Review PR #${pr.number}: ${pr.title}

Repository: ${pr.owner}/${pr.repo}
PR URL: ${pr.url}
Base ref: ${pr.baseRef}
Head SHA: ${pr.headSha}
${siblingContext}
${manifestContext}
${toolchainContext}
${formatReviewBotContext(input.botConfig)}
${AGENT_PRIOR_CONTRACT}
${SOURCE_VERIFICATION_CONTRACT}
${TOKEN_DISCIPLINE_CONTRACT}

Cross-Repo Search contract:
- The reviewed Repo (${pr.owner}/${pr.repo}) is your current working directory. Sibling Repos, when present, are available read-only at the paths listed above; each worktree maps to the shown owner/name Repo at its recorded default-branch SHA.
- Primary trigger: run Cross-Repo Search when the PR diff changes, removes, or adds a public-surface item listed in the API Surface Manifest. Include old deleted names from the diff, because the Manifest is built at the PR head and may only list the new surface.
- Secondary diff-judgment trigger: run targeted Cross-Repo Search when the diff is likely to affect a sibling Repo's behavior or assumptions even if the Manifest does not model it, including auth, routes, data shape or semantics, events, config, permissions, storage paths, generated artifacts, and shared conventions.
- Skip Cross-Repo Search for CSS-only, test-only, or otherwise local-only changes unless the diff suggests a cross-repo contract risk.
- Search siblings with \`rg\` and focused shell reads against the checked-out code, not from the Manifest alone. Confirm each hit is a real usage: resolved import, actual call site, or key lookup. Read imports, call sites, and surrounding syntax for structural confirmation when a symbol is too generic to grep safely. Never report coincidental string matches.
- Emit one Finding per changed contract item and put all confirmed sibling consumers in crossRepoReferences; do not emit one Finding per reference. Let severity reflect the true confirmed consumer count even if the rendered reference list is later capped. Frame these as cross-repo contract drift judged against sibling main/default branch. This rule is symmetric: producer-side removals/renames and consumer-side use of symbols absent from sibling main can both be Findings.
- Always fill crossRepoSearch in the JSON output: say why you searched siblings, or say that no cross-repo contract risk was detected.
- \`status\` and \`trigger\` are a matched pair, not independent fields: a skip is exactly \`{"status":"skipped","trigger":"none"}\`; a search is \`"status":"searched"\` with \`"trigger":"manifest"\` or \`"diff-judgment"\` (never \`"none"\`).

You are running inside the checked-out PR worktree. Review the diff and emit exactly one JSON object inside <findings>...</findings>. Each finding must use an in-diff "anchor"; use "crossRepoReferences" only for confirmed affected sibling-Repo consumers:

<findings>
{
  "summary": "Optional one-paragraph review summary",
  "crossRepoSearch": {
    "status": "searched" | "skipped",
    "trigger": "manifest" | "diff-judgment" | "none",
    "rationale": "Why you searched sibling Repos, or why no cross-repo contract risk was detected.",
    "searchedRepos": ["owner/name"]
  },
  "findings": [
    {
      "severity": "P0" | "P1" | "P2",
      "confidence": 0,
      "agentKey": "<your agent key>",
      "anchor": { "repo": "owner/name", "path": "relative/path/from/repo/root.ts", "lineStart": 42, "lineEnd": 45 },
      "crossRepoReferences": [{ "repo": "owner/sibling-repo", "path": "relative/path.ts", "line": 31 }],
      "summary": "One sentence describing the issue",
      "evidence": "Why this is an issue, with code quotes or rg results",
      "suggestedFix": "Optional: how to fix",
      "category": "<your category>"
    }
  ]
}
</findings>

The finding above is an illustrative shape, not a real finding. "anchor" is REQUIRED on every finding and must be an object with repo/path/lineStart/lineEnd on an in-diff line. Omit "crossRepoReferences" unless you confirmed affected sibling-Repo consumers. Emit "findings": [] when you find nothing.
`;
}

/**
 * Tell every Agent whether the worktree can run package scripts.
 * When the install succeeded the Agents may execute tests for verified
 * Findings; when it was skipped or failed they must not burn their execution
 * budget discovering that pnpm/vitest cannot work (the pre-install failure
 * mode behind the logic Agent's timeouts on PR graindevue#236).
 */
function formatDependencyInstallContext(result: DependencyInstallResult | undefined): string {
  if (result === undefined) {
    return '';
  }
  switch (result.status) {
    case 'installed': {
      const testStatusContext = {
        passed:
          '- Sandy ran the project test suite once and it passed. Do NOT rerun the full suite.',
        failed:
          '- Sandy attempted the project test suite once and it failed. Do NOT rerun the full suite.',
        skipped:
          '- Sandy did not run the project test suite because no project test script is defined.',
        unavailable: '- Test-suite status was not recorded for this Review.',
      }[result.testStatus ?? 'unavailable'];
      return `
Review toolchain:
- Dependencies are installed: \`${result.command}\` completed in ${Math.round(result.durationMs / 1000)}s before this Review. node_modules is present in the worktree.
- You MAY run a targeted package script or test needed to verify a concrete Finding. Use the same package manager and exact version shown in the install command above; use its pinned npx invocation for pnpm scripts.
- Do NOT re-run a dependency install; it already happened.
- In a monorepo, a test that fails to resolve a workspace package's entry needs that package built first — build only what the test imports, never the whole Repo.
${testStatusContext}
${result.testResult !== undefined ? `\nTest-suite result:\n${result.testResult}\n` : ''}
`;
    }
    case 'skipped':
      return `
Review toolchain:
- No dependency install ran for this Review: ${result.reason}.
- node_modules is NOT available. Do NOT run package-manager or test commands (pnpm/npm/yarn/bun install, test runners, tsc) — they will fail and waste your execution budget.
- Limit yourself to static analysis. If a Finding would need test execution to confirm, state the hypothesis with the evidence you have and mark it unverified.
`;
    case 'failed':
      return `
Review toolchain:
- Dependency install FAILED before this Review${result.command !== undefined ? ` (\`${result.command}\`)` : ''}: ${result.error}
- node_modules is NOT available. Do NOT run package-manager or test commands (pnpm/npm/yarn/bun install, test runners, tsc) — they will fail and waste your execution budget.
- Limit yourself to static analysis. If a Finding would need test execution to confirm, state the hypothesis with the evidence you have and mark it unverified.
`;
  }
}

function formatReviewBotContext(config: ReviewBotContext | undefined): string {
  if (config === undefined) {
    return '';
  }

  const sections: string[] = [];
  if (config.productRules !== null) {
    sections.push(`## Product Rules

Rules from .bot/product-rules.md across this Product:

${config.productRules}`);
  }
  if (config.repoRules !== null) {
    sections.push(`## Repo-local Rules

Rules from .bot/rules.md for only this Repo:

${config.repoRules}`);
  }
  if (config.ignorePatterns.length > 0) {
    sections.push(`## Ignored Diff Paths

Files matching these .bot/ignore.gitignore patterns are excluded from Sandy's review diff. Do not review changes whose paths match them:

${config.ignorePatterns.map((pattern) => `- ${pattern}`).join('\n')}

If a diff tool still displays an ignored path, disregard that file's hunks.`);
  }

  return sections.length === 0 ? '' : `\n\n${sections.join('\n\n')}`;
}
