import { execFile } from 'node:child_process';

/** Keep fixture writes out of the caller's repository, including inside Git hooks. */
export function fixtureGit(
  args: readonly string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}
