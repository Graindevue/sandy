// Parallel Planner with Review Gate — orchestration loop
//
// This template drives a multi-phase AFK workflow over Sandy's own backlog:
//   Phase 1 (Plan):    An agent analyzes open issues, builds a dependency graph,
//                      and outputs a <plan> JSON listing unblocked issues with
//                      branch names.
//   Phase 2 (Execute): For each issue, a sandbox is created via createSandbox().
//                      The implementer runs first (100 iterations), then local
//                      review, then publish (draft PR with `Closes #<id>` so
//                      GitHub closes the issue on manual merge), then the review
//                      gate (CodeRabbit) until the PR is clean.
//
// The pipeline stops at "ready for human review": PRs are left in their
// post-review-gate state so the human can review and merge manually. No
// automated staging merge.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up between rounds.
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
    if (process.env[key!] !== undefined) continue;
    const value = rawValue!.replace(/^['"]|['"]$/g, '');
    process.env[key!] = value;
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

// Gitignored cache dir for bind-mounted pnpm store (see .sandcastle/.gitignore).
mkdirSync('.sandcastle/pnpm-store', { recursive: true });

const sandboxProvider = appleContainer({
  imageName: SANDBOX_IMAGE_NAME,
  env: {
    GH_TOKEN: GITHUB_TOKEN,
    CURSOR_API_KEY,
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
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          'pnpm exec vitest --version >/dev/null 2>&1 || CI=true pnpm install --frozen-lockfile',
        timeoutMs: 600_000,
      },
    ],
  },
};

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
  let plan: { stdout: string };
  try {
    plan = await sandcastle.run({
      hooks,
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
    throw new Error('Planning agent did not produce a <plan> tag.\n\n' + plan.stdout);
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
  // Phase 2: Execute + Local Review + Review Gate
  //
  // For each issue, create a sandbox via createSandbox() so implementer,
  // reviewer, and the review gate share the same sandbox instance per branch.
  // The implementer runs first. If it produces commits, the local reviewer
  // cleans up before publishing a PR. The review gate (CodeRabbit) then runs.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
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

        const publish = await sandbox.run({
          name: 'publisher',
          maxIterations: 3,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          agent: sandcastle.codex('gpt-5.5', { effort: 'medium' }),
          promptFile: './.sandcastle/publish-pr-prompt.md',
          // Stop as soon as the agent emits <pr_url>. Without this, the
          // orchestrator's default <promise>COMPLETE</promise> signal is
          // never matched and the publisher runs all 3 iterations.
          completionSignal: '<pr_url>',
          // TARGET_BRANCH is a sandcastle built-in (auto-injected, = the host
          // branch this run launched from); passing it via promptArgs throws.
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        const prUrlMatch = publish.stdout.match(/<pr_url>([\s\S]*?)<\/pr_url>/);
        if (!prUrlMatch) {
          throw new Error(
            `Publisher did not produce a <pr_url> tag for ${issue.branch}.\n\n${publish.stdout}`,
          );
        }
        const prUrl = prUrlMatch[1]!.trim();

        const reviewGate = await sandbox.run({
          name: 'review-gate',
          maxIterations: 20,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          agent: sandcastle.codex('gpt-5.5', { effort: 'xhigh' }),
          promptFile: './.sandcastle/review-gate-prompt.md',
          // Stop on either terminal state the prompt defines. Without this, a
          // clean gate still triggers another iteration, which has hit agent
          // CLI startup failures and crashed the whole pipeline.
          completionSignal: [
            '<review-gate>clean</review-gate>',
            '<review-gate>blocked</review-gate>',
          ],
          promptArgs: {
            BRANCH: issue.branch,
            PR_URL: prUrl,
          },
        });

        if (!reviewGate.stdout.includes('<review-gate>clean</review-gate>')) {
          console.error(`  ✗ ${issue.id} (${issue.branch}) blocked by the review gate.`);
          return { ...reviewGate, commits: [] };
        }

        // Aggregate commits from every phase so the iteration summary below
        // counts a branch as "produced commits" even if only the implementer
        // committed but reviewer/review-gate didn't.
        return {
          ...reviewGate,
          commits: [...implement.commits, ...review.commits, ...reviewGate.commits],
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

  const completedBranches = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) => entry.outcome.status === 'fulfilled' && entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue.branch);

  console.log(
    `\nIteration complete. ${completedBranches.length} branch(es) ready for human review:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }
}

console.log('\nAll done.');
