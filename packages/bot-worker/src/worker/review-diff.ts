import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIgnoredPath } from '../config/ignore.js';
import type { RunAgentInput } from './codex-exec-runner.js';

const exec = promisify(execFile);

/** Both review adapters receive the same bounded, filtered revision diff. */
export async function readReviewDiff(
  input: RunAgentInput,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const options = {
    cwd: input.worktreePath,
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const revision = `refs/remotes/origin/${input.pullRequest.baseRef}...${input.pullRequest.headSha}`;
  const { stdout: changed } = await exec(
    'git',
    ['diff', '--name-status', '--find-renames', '-z', revision, '--'],
    options,
  );
  const entries = changed.split('\0');
  const paths: string[][] = [];
  for (let index = 0; index < entries.length && entries[index] !== ''; ) {
    const status = entries[index++];
    const before = entries[index++];
    const renamed = status?.startsWith('R') || status?.startsWith('C');
    const after = renamed ? entries[index++] : before;
    if (before === undefined || after === undefined)
      throw new Error('Git emitted incomplete changed-path metadata');
    if (!isIgnoredPath(after, input.botConfig?.ignorePatterns))
      paths.push(renamed ? [before, after] : [after]);
  }
  let diff = '';
  // Literal pathspecs protect unusual filenames; chunks avoid argv limits.
  for (let index = 0; index < paths.length; index += 100) {
    const { stdout } = await exec(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--find-renames',
        revision,
        '--',
        ...[...new Set(paths.slice(index, index + 100).flat())].map((path) => `:(literal)${path}`),
      ],
      options,
    );
    diff += stdout;
    if (diff.length > 16 * 1024 * 1024)
      throw new Error('Review diff exceeds 16MiB after ignored paths are excluded');
  }
  return diff;
}
