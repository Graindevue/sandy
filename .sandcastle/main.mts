// Parallel Planner with Autonomous Merge — orchestration loop
//
// This template drives a multi-phase AFK workflow over Sandy's own backlog:
//   Phase 1 (Plan):    An agent analyzes open issues, builds a dependency graph,
//                      and outputs a <plan> JSON listing unblocked issues with
//                      branch names.
//   Phase 2 (Execute): For each issue, a sandbox is created via createSandbox().
//                      The implementer runs first (100 iterations), then a local
//                      review pass — both in the same per-branch sandbox.
//   Phase 3 (Merge):   One agent merges every completed branch into the
//                      integration branch (staging), keeping it green at each
//                      step. The orchestrator then pushes staging to origin and
//                      closes the merged issues.
//
// There are no per-issue PRs and no external automated reviewer: work is merged
// autonomously into staging once it passes local review + the merge-time
// type-check/test gate. The human reviews the accumulated staging diff and
// promotes staging→main via a separate release PR (see AGENTS.md).
//
// The outer loop repeats up to MAX_ITERATIONS times; because each cycle merges
// and closes its issues, the next plan sees newly unblocked work and the merged
// integration branch.
//
// Usage:
//   pnpm sandcastle
// (equivalently: npx tsx .sandcastle/main.mts)
//
// Prerequisites:
//   - Install + build the workspace so the provider's dist exists:
//       pnpm install && pnpm -r build
//   - Build the harness agent image:   pnpm sandcastle:build-agent-image
//   - Provide secrets in .sandcastle/.env (see .env.example).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Node blocks --env-file in NODE_OPTIONS, so load .sandcastle/.env ourselves.
// Existing process.env wins (lets users override per-shell).
function loadDotenv(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}
loadDotenv('.sandcastle/.env');

import * as sandcastle from '@ai-hero/sandcastle';

// The Apple Container provider lives in its own workspace package (ADR 0009).
// Run `pnpm -r build` once so its dist is present before invoking this script.
import { appleContainer } from '@sandy/apple-container-provider';

const SANDBOX_IMAGE_NAME = 'sandcastle:sandy';
const GITHUB_TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
const CURSOR_API_KEY = process.env.CURSOR_API_KEY;
if (!CURSOR_API_KEY) {
  throw new Error(
    'CURSOR_API_KEY is not set. Put it in .sandcastle/.env or export it in your shell.',
  );
}

// Full-repo type-check/test can run for minutes with no agent stdout between
// tool calls; Sandcastle's default 600s idle timeout then kills healthy agents.
const IDLE_TIMEOUT_SECONDS = 30 * 60;

// Gitignored cache dirs for bind-mounted pnpm store + convex-local-backend
// binary (see .sandcastle/.gitignore).
mkdirSync('.sandcastle/pnpm-store', { recursive: true });
mkdirSync('.sandcastle/convex-cache', { recursive: true });

const sandboxProvider = appleContainer({
  imageName: SANDBOX_IMAGE_NAME,
  env: {
    GH_TOKEN: GITHUB_TOKEN,
    CURSOR_API_KEY,
    // Run the Convex CLI as an anonymous agent: `convex dev`/`codegen` configure
    // and target a login-free local backend instead of failing on an unset
    // CONVEX_DEPLOYMENT. See ADR 0013.
    CONVEX_AGENT_MODE: 'anonymous',
  },
  mounts: [
    {
      hostPath: '~/.codex',
      sandboxPath: '/home/agent/.codex',
      readonly: false,
    },
    {
      hostPath: '~/.config/gh',
      sandboxPath: '/home/agent/.config/gh',
      readonly: true,
    },
    {
      // Mount only the GitHub identity, not the whole ~/.ssh directory:
      // narrower exposure (other keys stay on the host) and lets the
      // image's baked-in Linux config + known_hosts take precedence over
      // the host's macOS-flavored ~/.ssh/config.
      hostPath: '~/.ssh/id_ed25519',
      sandboxPath: '/home/agent/.ssh/id_ed25519',
      readonly: true,
    },
    {
      hostPath: '~/.opensrc',
      sandboxPath: '/home/agent/.opensrc',
      readonly: false,
    },
    {
      hostPath: '.sandcastle/pnpm-store',
      sandboxPath: '/home/agent/.local/share/pnpm/store',
      readonly: false,
    },
    {
      // convex-local-backend binary cache (ADR 0013). Like the pnpm store, this
      // is a write-once cache shared across sandboxes: the first sandbox
      // downloads the binary, the rest reuse it. The anonymous deployment STATE
      // lives in each container's own ~/.convex, so parallel sandboxes stay
      // isolated — only the binary is shared here.
      hostPath: '.sandcastle/convex-cache',
      sandboxPath: '/home/agent/.cache/convex',
      readonly: false,
    },
  ],
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the Linux sandbox before the agent starts each iteration.
// Do not copy macOS node_modules into the sandbox: native optional packages
// (e.g. Rolldown/Vitest bindings) are platform-specific and break inside the
// Linux VM.
//
// The pre-flight check actually *invokes* vitest rather than just checking file
// existence: a file-existence check passed even when platform-native bindings
// were missing, which led to agents committing code without running tests.
// Sandy builds with `pnpm -r` (no turbo), so we probe vitest directly.
// The convex step then configures a login-free anonymous Convex deployment and
// warms the convex-local-backend binary (ADR 0013) so `pnpm --filter
// @sandy/convex-backend build` (convex codegen) works for the agents and the
// merge gate. `--typecheck disable` keeps sandbox setup decoupled from
// TypeScript — the agents run `pnpm type-check` themselves. CONVEX_AGENT_MODE is
// set on the provider env, so this is non-interactive. The first sandbox on a
// fresh host downloads the backend binary into the bind-mounted cache; the rest
// reuse it.
//
// CONVEX_DEPLOYMENT is cleared inline: convex selects a deployment from the
// environment (incl. a dotenv-loaded .env.local) BEFORE it consults
// CONVEX_AGENT_MODE, so a real `dev:` deployment wins and forces an interactive
// login. The planner runs against the live host repo (no isolated worktree), so
// the host's gitignored packages/convex-backend/.env.local is visible inside the
// sandbox. dotenv won't override an already-set env var and convex treats an
// empty CONVEX_DEPLOYMENT as unset, so this pins the anonymous path everywhere.
//
// Both steps are ONE hook chained with `&&`, not two array entries: Sandcastle
// runs onSandboxReady hooks concurrently (Effect.all, unbounded). As separate
// hooks, `pnpm --filter @sandy/convex-backend exec convex` races the still-
// running `pnpm install` and resolves the convex bin from a half-linked
// node_modules — failing with `Command "convex" not found` (exit 254). Chaining
// forces install → codegen, and skips convex if the install itself fails.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          '( pnpm exec vitest --version >/dev/null 2>&1 || CI=true pnpm install --frozen-lockfile )' +
          ' && CONVEX_DEPLOYMENT= pnpm --filter @sandy/convex-backend exec convex dev --once --typecheck disable',
        timeoutMs: 600_000,
      },
    ],
  },
};

// The planner only reads the issue tracker and reasons about a dependency graph
// (see plan-prompt.md) — it never builds, tests, or runs convex codegen. Unlike
// the executor/merger sandboxes (isolated git worktrees), it runs against the
// live host repo, so the workspace-prep hooks above are both useless and unsafe
// there: convex codegen's esbuild fails against the host's macOS node_modules,
// and `pnpm install` / `convex dev` would mutate the host checkout (the latter
// rewrites packages/convex-backend/.env.local to the anonymous deployment).
// Give the planner no setup hooks.
const plannerHooks = { sandbox: { onSandboxReady: [] } };

const copyToWorktree: string[] = [];

// Repository branching policy (AGENTS.md): work targets staging only.
// Never target or merge into main.
//
// Sandcastle 0.6.5 derives the prompts' built-in {{TARGET_BRANCH}} from the
// branch this script is launched on (the host branch), and creates each issue
// worktree off that same branch. So to satisfy the policy you must run this
// from `staging`: the PR base and the worktree base both follow the host
// branch. This const is the policy expectation we check the host branch against
// below — it is NOT passed into promptArgs (that would override the built-in
// and throw).
const TARGET_BRANCH = 'staging';

function assertSandboxImageExists() {
  try {
    execFileSync('container', ['image', 'inspect', SANDBOX_IMAGE_NAME], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error(
      `Container image ${SANDBOX_IMAGE_NAME} is missing. Build it with: pnpm sandcastle:build-agent-image`,
    );
  }
}

assertSandboxImageExists();

// Sandcastle preserves worktrees across runs and reuses them — including any
// uncommitted state left by a crashed previous run. That stale state has caused
// agents to refuse to touch "deleted" files (e.g. pnpm-lock.yaml) and silently
// skip tests/type-check. Reset the worktree to HEAD and prune untracked files
// before reusing it. Untracked node_modules and other gitignored paths are kept
// (no -x), so we don't pay for a full pnpm install every iteration.
function cleanReusedWorktree(branch: string) {
  const sanitized = branch.replace(/[/\\:*?"<>|]/g, '-');
  const worktreePath = path.join('.sandcastle', 'worktrees', sanitized);
  if (!existsSync(worktreePath)) return;
  console.log(`Cleaning reused worktree at ${worktreePath}`);
  try {
    execFileSync('git', ['-C', worktreePath, 'reset', '--hard', 'HEAD'], {
      stdio: 'inherit',
    });
    execFileSync('git', ['-C', worktreePath, 'clean', '-fd'], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn(`Worktree cleanup failed for ${worktreePath}: ${err}`);
  }
}

const currentBranch = execSync('git branch --show-current', {
  encoding: 'utf8',
}).trim();

if (currentBranch === 'main') {
  throw new Error('Sandcastle must not run from main. Check out staging first.');
}

if (currentBranch !== TARGET_BRANCH) {
  console.warn(
    `Warning: branching policy expects ${TARGET_BRANCH}, but you are on ${currentBranch}. ` +
      `Sandcastle will base new issue worktrees on ${currentBranch} and open PRs ` +
      `targeting ${currentBranch}. Switch to ${TARGET_BRANCH} for policy-correct runs.`,
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent reads the open issue list, builds a dependency graph,
  // and selects the issues that can be worked in parallel right now (i.e., no
  // blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  let plan: sandcastle.RunResult;
  try {
    plan = await sandcastle.run({
      hooks: plannerHooks,
      sandbox: sandboxProvider,
      name: 'planner',
      // One iteration is enough: the planner just needs to read and reason,
      // not write code.
      maxIterations: 1,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      agent: sandcastle.codex('gpt-5.5', { effort: 'low' }),
      promptFile: './.sandcastle/plan-prompt.md',
    });
  } catch (err) {
    // Transient agent/sandbox failures (rate limits, auth blips, network)
    // should not take the whole pipeline down — skip this outer iteration.
    console.error(`Planner failed on iteration ${iteration}: ${err}`);
    continue;
  }

  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(`Planning agent did not produce a <plan> tag.\n\n${plan.stdout}`);
  }

  // The plan JSON contains an array of issues, each with id, title, branch.
  const { issues } = JSON.parse(planMatch[1]!) as {
    issues: { id: string; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log('No unblocked issues to work on. Exiting.');
    break;
  }

  console.log(`Planning complete. ${issues.length} issue(s) to work in parallel:`);
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Local Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer and
  // reviewer share the same sandbox instance per branch. The implementer runs
  // first; if it produces commits, the local reviewer cleans up. Each issue
  // pipeline runs concurrently via Promise.allSettled, so one failing pipeline
  // does not cancel the others.
  //
  // No PR is opened and no external reviewer runs: the local review is the
  // quality pass, and the merge phase re-runs type-check/test as the real gate
  // before anything lands on the integration branch.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      cleanReusedWorktree(issue.branch);

      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: sandboxProvider,
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: 'implementer',
          maxIterations: 100,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          agent: sandcastle.codex('gpt-5.5', { effort: 'xhigh' }),
          promptFile: './.sandcastle/implement-prompt.md',
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Nothing implemented → nothing to review or merge.
        if (implement.commits.length === 0) {
          return implement;
        }

        const review = await sandbox.run({
          name: 'reviewer',
          maxIterations: 1,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          agent: sandcastle.codex('gpt-5.5', { effort: 'xhigh' }),
          promptFile: './.sandcastle/review-prompt.md',
          // TARGET_BRANCH is a sandcastle built-in (the host branch this run was
          // launched from) and must NOT be passed here — it is auto-injected,
          // and passing it throws. SOURCE_BRANCH (the issue branch) is too.
          promptArgs: {
            BRANCH: issue.branch,
          },
        });

        // Aggregate commits from both phases so the branch counts as "produced
        // commits" even if only the implementer committed and the reviewer
        // found nothing to change.
        return {
          ...review,
          commits: [...implement.commits, ...review.commits],
        };
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      console.error(`  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`);
    }
  }

  // Only branches that actually produced commits can be merged.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) => entry.outcome.status === 'fulfilled' && entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(`\nExecution complete. ${completedBranches.length} branch(es) with commits:`);
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log('No commits produced. Nothing to merge this cycle.');
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge → push integration branch
  //
  // One agent merges every completed branch into the integration branch, one at
  // a time, keeping it green (type-check + test) at each step and skipping any
  // branch it cannot merge cleanly. It runs with the "merge-to-head" branch
  // strategy: it works in an isolated temp worktree (so its Linux `pnpm install`
  // never clobbers the host's macOS node_modules), and Sandcastle fast-forwards
  // the host integration branch to the merged result when the run returns.
  //
  // The agent does NOT push or close issues — local HEAD isn't advanced until
  // after the run. The orchestrator does both here, deterministically, gated on
  // the agent's reported <merge-result>: push first, then close only the issues
  // that actually merged.
  // -------------------------------------------------------------------------
  let merge: sandcastle.RunResult;
  try {
    merge = await sandcastle.run({
      hooks,
      sandbox: sandboxProvider,
      name: 'merger',
      maxIterations: 1,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      // Isolated temp worktree, fast-forwarded back into the host branch on
      // success. Without this, the default "head" strategy for bind-mount
      // providers would run the merger's Linux `pnpm install` against the
      // host's macOS worktree.
      branchStrategy: { type: 'merge-to-head' },
      agent: sandcastle.codex('gpt-5.5', { effort: 'low' }),
      promptFile: './.sandcastle/merge-prompt.md',
      // Stop once the structured result block is complete.
      completionSignal: '</merge-result>',
      promptArgs: {
        BRANCHES: completedBranches.map((b) => `- ${b}`).join('\n'),
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join('\n'),
      },
    });
  } catch (err) {
    console.error(`Merge phase failed on iteration ${iteration}: ${err}`);
    continue;
  }

  // Parse the merger's structured result. If it is missing or unparseable, do
  // not push or close anything — leave the integration branch and the issues
  // as-is for the next cycle rather than guessing.
  const resultMatch = merge.stdout.match(/<merge-result>([\s\S]*?)<\/merge-result>/);
  if (!resultMatch) {
    console.error('Merger did not emit a <merge-result> block; skipping push and issue close.');
    continue;
  }

  let mergedIds: string[] = [];
  let skipped: { id: string; reason: string }[] = [];
  try {
    const parsed = JSON.parse(resultMatch[1]!) as {
      merged?: string[];
      skipped?: { id: string; reason: string }[];
    };
    mergedIds = parsed.merged ?? [];
    skipped = parsed.skipped ?? [];
  } catch (err) {
    console.error(`Could not parse <merge-result> JSON: ${err}`);
    continue;
  }

  for (const s of skipped) {
    console.warn(`  ⚠ issue ${s.id} skipped by merger: ${s.reason}`);
  }

  if (mergedIds.length === 0) {
    console.log('Merger kept no branches. Nothing to push.');
    continue;
  }

  // Push the merged integration branch to origin so the work is visible for the
  // human staging→main release PR. Push BEFORE closing issues: if the push
  // fails, the issues stay open and the work is retried next cycle.
  try {
    execFileSync('git', ['push', 'origin', currentBranch], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`Failed to push ${currentBranch}; leaving issues open: ${err}`);
    continue;
  }

  // Close the issues whose branches landed on the integration branch.
  for (const id of mergedIds) {
    try {
      execFileSync(
        'gh',
        ['issue', 'close', id, '-c', `Merged into ${currentBranch} by sandcastle.`],
        { stdio: 'inherit' },
      );
    } catch (err) {
      console.warn(`  ⚠ could not close issue ${id}: ${err}`);
    }
  }

  console.log(
    `\nIteration complete. Merged ${mergedIds.length} issue(s) into ${currentBranch} and pushed.`,
  );
}

console.log('\nAll done.');
