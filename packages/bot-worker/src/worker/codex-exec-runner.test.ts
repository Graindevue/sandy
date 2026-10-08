import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentDefinition } from '@sandy/shared-types';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexExecRunner, type RunAgentInput } from './codex-exec-runner.js';
import { readPackageJson } from './dependency-install.js';

const exec = promisify(execFile);
const directories: string[] = [];
const findings =
  '<findings>{"findings":[],"crossRepoSearch":{"status":"skipped","trigger":"none","rationale":"Local change"}}</findings>';
const agent: AgentDefinition = {
  key: 'logic',
  name: 'Logic',
  description: 'Find bugs',
  category: 'logic',
  vendor: 'codex',
  model: 'gpt-5.5',
  effort: 'xhigh',
  tools: [],
  maxIterations: 30,
  completionSignal: '</findings>',
  defaultEnabled: true,
  systemPrompt: 'Find concrete bugs.',
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(program: string, temporaryDirectory = tmpdir()) {
  const root = await mkdtemp(join(temporaryDirectory, 'sandy-codex-runner-'));
  directories.push(root);
  const worktreePath = join(root, 'repo');
  const codexHome = join(root, 'ci-codex');
  await mkdir(worktreePath);
  await mkdir(codexHome);
  await exec('git', ['init', '-b', 'main'], { cwd: worktreePath });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: worktreePath });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreePath });
  await writeFile(join(worktreePath, 'review.ts'), 'export const before = true;\n');
  await exec('git', ['add', '.'], { cwd: worktreePath });
  await exec('git', ['commit', '-m', 'base'], { cwd: worktreePath });
  await exec('git', ['remote', 'add', 'origin', worktreePath], { cwd: worktreePath });
  await exec('git', ['checkout', '-b', 'feature'], { cwd: worktreePath });
  await writeFile(join(worktreePath, 'review.ts'), 'export const after = false;\n');
  await exec('git', ['commit', '-am', 'change'], { cwd: worktreePath });
  await exec('git', ['fetch', 'origin'], { cwd: worktreePath });
  const headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
  const executable = join(root, 'codex');
  await writeFile(executable, `#!/usr/bin/env node\n${program}`);
  await chmod(executable, 0o755);
  const input: RunAgentInput = {
    agent,
    worktreePath,
    pullRequest: {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      headSha,
      baseRef: 'main',
      title: 'Fix behavior',
      url: 'https://github.com/acme/widget/pull/42',
    },
  };
  return { root, input, codexHome, executable };
}

describe('CodexExecRunner through ReviewAgentRunner.runAgent', () => {
  it('reviews the actual PR diff in one invocation and records final-message usage without double-counting cached input', async () => {
    const f = await fixture(`
      let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
      const args = process.argv.slice(2);
      if (!args.includes('--json') || args[args.indexOf('--model') + 1] !== 'gpt-5.5' || !args.includes('model_reasoning_effort="xhigh"')) throw new Error('Wrong model options');
      const shellPolicy = args.find(value => value.startsWith('shell_environment_policy.set='));
      for (const name of ['pnpm_config_verify_deps_before_run', 'pnpm_config_manage_package_manager_versions']) {
        if (!shellPolicy?.includes(name + '="false"') || process.env[name] !== 'false') throw new Error('Native pnpm command could reinstall or switch package-manager versions');
      }
      if (!prompt.includes('-export const before = true;') || !prompt.includes('+export const after = false;')) throw new Error('Missing PR diff');
      if (args.at(-1) !== '-') throw new Error('Prompt must be stdin');
      process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-one'}) + '\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Checking the diff'}}) + '\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'</findings>'}}) + '\\n');
      const line = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}}) + '\\n';
      process.stdout.write(line.slice(0,23)); process.stdout.write(line.slice(23));
      process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:70,reasoning_output_tokens:20}}));
    `);

    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(runner.runAgent(f.input)).resolves.toEqual({
      stdout: findings,
      usage: {
        inputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 800,
        outputTokens: 70,
      },
    });
  });

  it('resumes only the explicit review thread once and adds both turns of usage', async () => {
    const f = await fixture(`
      let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
      const args = process.argv.slice(2);
      const resumed = args.includes('resume');
      if (resumed && (!args.includes('review-thread') || args.includes('--last') || prompt.includes('PR diff:'))) throw new Error('Wrong resume context');
      process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'review-thread'}) + '\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:resumed ? ${JSON.stringify(findings)} : 'I inspected the change.'}}) + '\\n');
      process.stdout.write(JSON.stringify({type:'turn.completed',usage:resumed ? {input_tokens:600,cached_input_tokens:500,output_tokens:10} : {input_tokens:1000,cached_input_tokens:800,output_tokens:70}}) + '\\n');
    `);
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(runner.runAgent(f.input)).resolves.toEqual({
      stdout: findings,
      usage: {
        inputTokens: 300,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1300,
        outputTokens: 80,
      },
    });
  });

  it('serializes agents across runner instances sharing a rotating Codex login', async () => {
    const f = await fixture(`
      const fs = await import('node:fs/promises');
      const lock = process.env.CODEX_HOME + '/in-use';
      await fs.writeFile(lock, 'active', {flag:'wx'});
      for await (const chunk of process.stdin) {}
      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.unlink(lock);
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}}) + '\\n');
    `);
    const first = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    const second = new CodexExecRunner({
      codexHome: join(f.codexHome, '..', 'ci-codex'),
      executable: f.executable,
    });
    await expect(Promise.all([first.runAgent(f.input), second.runAgent(f.input)])).resolves.toEqual(
      [{ stdout: findings }, { stdout: findings }],
    );
  });

  it('kills the agent process tree on cancellation, including a detached child ignoring SIGTERM', async () => {
    const f = await fixture(`
      const {spawn} = await import('node:child_process');
      const {writeFile} = await import('node:fs/promises');
      for await (const chunk of process.stdin) {}
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'], {stdio:'ignore',detached:true});
      await writeFile('child.pid', String(child.pid));
      process.on('SIGTERM',()=>{}); setInterval(()=>{},100);
    `);
    const controller = new AbortController();
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    const pending = runner.runAgent({ ...f.input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('Review cancelled');
    const pidFile = join(f.input.worktreePath, 'child.pid');
    let pid: number | undefined;
    for (let tries = 0; tries < 100; tries++) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(pid).toBeTypeOf('number');
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error('Review cancelled'));
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  });

  it('ends a hung agent at its deadline instead of starting another invocation', async () => {
    const f = await fixture(
      'for await (const chunk of process.stdin) {} setInterval(()=>{}, 100);',
    );
    const runner = new CodexExecRunner({
      codexHome: f.codexHome,
      executable: f.executable,
      agentTimeoutMs: 100,
    });
    await expect(runner.runAgent(f.input)).rejects.toThrow('Codex agent exceeded 100ms');
  });

  it('keeps write credentials out of the agent environment and enforces denied credential paths', async () => {
    const f = await fixture(`
      for await (const chunk of process.stdin) {}
      const args = process.argv.slice(2);
      if (process.env.GH_TOKEN || process.env.SANDY_APP_PRIVATE_KEY || process.env.OPENAI_API_KEY) throw new Error('Write credentials inherited');
      if (args.includes('--dangerously-bypass-approvals-and-sandbox') || args.includes('--sandbox')) throw new Error('Filesystem denies bypassed');
      if (!args.includes('default_permissions="sandy"')) throw new Error('Missing enforced permissions');
      const profile = args.find(arg => arg.startsWith('permissions.sandy='));
      if (!profile?.includes(process.env.CODEX_HOME) || !profile.includes('app.pem') || !profile.includes('"deny"')) throw new Error('Missing protected paths');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}}) + '\\n');
    `);
    const runner = new CodexExecRunner({
      codexHome: f.codexHome,
      executable: f.executable,
      protectedPaths: [join(f.root, 'app.pem')],
      env: {
        GH_TOKEN: 'do-not-inherit',
        SANDY_APP_PRIVATE_KEY: 'do-not-inherit',
        OPENAI_API_KEY: 'do-not-inherit',
      },
    });
    await expect(runner.runAgent(f.input)).resolves.toEqual({ stdout: findings });
  });

  it('fails a rejected Codex turn even if the stream contains a findings-shaped message', async () => {
    const f = await fixture(`
      for await (const chunk of process.stdin) {}
      process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'failed-thread'}) + '\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}}) + '\\n');
      process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Subscription limit reached'}}) + '\\n');
    `);
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(runner.runAgent(f.input)).rejects.toThrow('Subscription limit reached');
  });

  it('excludes ignored generated diff content before preparing the prompt while preserving negated ignore patterns', async () => {
    const f = await fixture(`
      let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
      if(prompt.includes('PRIVATE_GENERATED_DIFF'))throw new Error('Ignored diff leaked');
      if(!prompt.includes('REVIEW_THIS_GENERATED_FILE'))throw new Error('Negated pattern lost');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}})+'\\n');
    `);
    await mkdir(join(f.input.worktreePath, 'generated'));
    await writeFile(
      join(f.input.worktreePath, 'generated', 'large.ts'),
      'PRIVATE_GENERATED_DIFF\n',
    );
    await writeFile(
      join(f.input.worktreePath, 'generated', 'keep.ts'),
      'REVIEW_THIS_GENERATED_FILE\n',
    );
    await exec('git', ['add', '.'], { cwd: f.input.worktreePath });
    await exec('git', ['commit', '-m', 'generated changes'], { cwd: f.input.worktreePath });
    f.input.pullRequest.headSha = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: f.input.worktreePath })
    ).stdout.trim();
    f.input.botConfig = {
      productRules: null,
      repoRules: null,
      ignorePatterns: ['generated/**', '!generated/keep.ts'],
    };
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(runner.runAgent(f.input)).resolves.toEqual({ stdout: findings });
  });

  it('preserves deleted names in a renamed file so cross-repo reviewers can search old consumers', async () => {
    const f = await fixture(`
      let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
      if(!prompt.includes('rename from review.ts')||!prompt.includes('rename to renamed.ts'))throw new Error('Rename context lost');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(findings)}}})+'\\n');
    `);
    await exec('git', ['mv', 'review.ts', 'renamed.ts'], { cwd: f.input.worktreePath });
    // Keep enough shared lines for Git's independent rename detection.
    await writeFile(join(f.input.worktreePath, 'renamed.ts'), 'export const before = true;\n');
    await exec('git', ['commit', '-am', 'rename'], { cwd: f.input.worktreePath });
    f.input.pullRequest.headSha = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: f.input.worktreePath })
    ).stdout.trim();
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(runner.runAgent(f.input)).resolves.toEqual({ stdout: findings });
  });
});

describe('CodexExecRunner through ReviewAgentRunner.installDependencies', () => {
  it('rejects a reviewed manifest symlink without reading its outside target', async () => {
    const f = await fixture('throw new Error("Install must not start");');
    const outside = join(f.root, 'outside-secret');
    await writeFile(outside, 'private sentinel must not appear in an error');
    await symlink(outside, join(f.input.worktreePath, 'package.json'));
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toEqual({ status: 'failed', error: 'package.json must be a regular file' });
  });

  it('restores over a malicious manifest symlink without overwriting its outside target', async () => {
    const f = await fixture(`
      const fs = await import('node:fs/promises');
      await fs.unlink('package.json');
      await fs.symlink('../outside-secret', 'package.json');
      process.exitCode = 1;
    `);
    const manifest = '{\n "scripts": {"prepare":"lefthook install"}\n}\n';
    const outside = join(f.root, 'outside-secret');
    await writeFile(outside, 'private sentinel');
    await writeFile(join(f.input.worktreePath, 'package.json'), manifest);
    await chmod(join(f.input.worktreePath, 'package.json'), 0o640);
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(await readFile(outside, 'utf8')).toBe('private sentinel');
    expect(await readFile(join(f.input.worktreePath, 'package.json'), 'utf8')).toBe(manifest);
    expect((await stat(join(f.input.worktreePath, 'package.json'))).mode & 0o777).toBe(0o640);
    expect(
      (await readdir(f.root)).filter((name) => name.startsWith('.sandy-package-json-')),
    ).toEqual([]);
  });

  it('restores the original manifest when the install process times out', async () => {
    const f = await fixture('setInterval(() => {}, 100);');
    const manifest = '{\n "scripts": {"prepare":"lefthook install"}\n}\n';
    await writeFile(join(f.input.worktreePath, 'package.json'), manifest);
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({
      codexHome: f.codexHome,
      executable: f.executable,
      installTimeoutMs: 300,
    });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toMatchObject({ status: 'failed', error: 'command exceeded 300ms' });
    expect(await readFile(join(f.input.worktreePath, 'package.json'), 'utf8')).toBe(manifest);
  });

  it('omits a hook-only prepare during installation and restores exact manifest bytes before tests', async () => {
    const manifest =
      '{\n  "scripts": {"prepare": "lefthook install", "postinstall": "node setup.js", "test": "node test.js"}\n}\n';
    const f = await fixture(`
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile('package.json', 'utf8');
      const scripts = JSON.parse(raw).scripts;
      if (process.argv.at(-1).includes(' ci ')) {
        if (scripts.prepare !== undefined) throw new Error('Hook-only prepare would mutate shared Git metadata');
        if (scripts.postinstall !== 'node setup.js') throw new Error('Dependency lifecycle was changed');
      } else if (raw !== ${JSON.stringify(manifest)}) throw new Error('Manifest not restored before tests');
      process.stdout.write('verified');
    `);
    await writeFile(join(f.input.worktreePath, 'package.json'), manifest);
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toMatchObject({ status: 'installed', testStatus: 'passed' });
    expect(await readFile(join(f.input.worktreePath, 'package.json'), 'utf8')).toBe(manifest);
  });

  it('preserves a compound prepare script and the original manifest during installation', async () => {
    const manifest = '{\n "scripts": {"prepare":"node build.js && lefthook install"}\n}\n';
    const f = await fixture(`
      const raw = await (await import('node:fs/promises')).readFile('package.json', 'utf8');
      if (raw !== ${JSON.stringify(manifest)}) throw new Error('Required prepare lifecycle was changed');
    `);
    await writeFile(join(f.input.worktreePath, 'package.json'), manifest);
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toMatchObject({ status: 'installed', testStatus: 'skipped' });
    expect(await readFile(join(f.input.worktreePath, 'package.json'), 'utf8')).toBe(manifest);
  });

  it('reports failed tests from the exit code even when reviewed output claims they passed', async () => {
    const f = await fixture(`
      const command = process.argv.at(-1);
      if (command.includes(' ci ')) process.stdout.write('dependencies ready');
      else { process.stdout.write('Tests passed'); process.exitCode = 1; }
    `);
    await writeFile(
      join(f.input.worktreePath, 'package.json'),
      JSON.stringify({ scripts: { test: 'node test.js' } }),
    );
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toMatchObject({
      status: 'installed',
      testStatus: 'failed',
      testResult: 'npm test exited 1.\nTests passed',
    });
  });

  it('preserves the sandbox startup error before a long diagnostic tail', async () => {
    const f = await fixture(`
      process.stderr.write('Fatal error: ripgrep unreadable glob scan failed for /proc\\n' + 'namespace permission denied\\n'.repeat(300) + 'last namespace diagnostic');
      process.exitCode = 2;
    `);
    await writeFile(join(f.input.worktreePath, 'package.json'), '{}');
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
    const result = await runner.installDependencies({ worktreePath: f.input.worktreePath });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected sandbox startup failure');
    expect(result.error).toContain('Fatal error: ripgrep unreadable glob scan failed for /proc');
    expect(result.error).toContain('last namespace diagnostic');
    expect(result.error.length).toBeLessThan(4100);
  });

  it.skipIf(process.platform !== 'linux' || process.env.SANDY_NATIVE_SANDBOX_TEST !== '1')(
    'runs one native Linux npm install and test with credentials inaccessible',
    async () => {
      const f = await fixture('throw new Error("Native probe must use the installed Codex CLI");');
      const keyPath = join(f.root, 'app.pem');
      const sandboxHome = join(f.root, 'sandy-sandbox-home');
      await writeFile(keyPath, 'dummy-probe-key');
      await writeFile(join(f.codexHome, 'auth.json'), '{"dummy":"probe-login"}');
      await mkdir(sandboxHome);
      await writeFile(join(sandboxHome, 'config.toml'), '');
      const manifest = JSON.stringify({
        name: 'sandy-native-sandbox-probe',
        version: '1.0.0',
        scripts: {
          prepare: 'lefthook install',
          postinstall: 'node probe.mjs install',
          test: 'node probe.mjs test',
        },
      });
      await writeFile(join(f.input.worktreePath, 'package.json'), manifest);
      await writeFile(
        join(f.input.worktreePath, 'package-lock.json'),
        JSON.stringify({
          name: 'sandy-native-sandbox-probe',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { name: 'sandy-native-sandbox-probe', version: '1.0.0', hasInstallScript: true },
          },
        }),
      );
      await writeFile(
        join(f.input.worktreePath, 'probe.mjs'),
        `import assert from 'node:assert/strict';
         import fs from 'node:fs';
         for (const path of ${JSON.stringify([join(f.codexHome, 'auth.json'), keyPath, `/proc/${process.pid}/environ`, `/proc/${process.pid}/mem`])}) {
           assert.throws(() => fs.openSync(path, 'r'), 'Credential path readable: ' + path);
         }
         assert.throws(() => fs.writeFileSync(${JSON.stringify(join(sandboxHome, 'config.toml'))}, 'malicious override'));
         assert.equal(process.env.GH_TOKEN, undefined);
         assert.equal(process.env.CODEX_AUTH_JSON, undefined);
         const countsPath = 'probe-counts.json';
         const counts = fs.existsSync(countsPath) ? JSON.parse(fs.readFileSync(countsPath, 'utf8')) : {install:0,test:0};
         const stage = process.argv[2];
         const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
         assert.equal(manifest.scripts.prepare, stage === 'install' ? undefined : 'lefthook install');
         counts[stage]++;
         assert.equal(counts.install, 1);
         assert.equal(counts.test, stage === 'test' ? 1 : 0);
         fs.writeFileSync(countsPath, JSON.stringify(counts));
         console.log(stage + ' verified');`,
      );
      const runner = new CodexExecRunner({
        codexHome: f.codexHome,
        protectedPaths: [keyPath],
        env: { GH_TOKEN: 'dummy-probe-token', CODEX_AUTH_JSON: 'dummy-probe-auth' },
      });
      const result = await runner.installDependencies({ worktreePath: f.input.worktreePath });
      if (result.status === 'failed') throw new Error(result.error);
      expect(result).toMatchObject({
        status: 'installed',
        testStatus: 'passed',
        testResult: expect.stringContaining('npm test exited 0.'),
      });
      if (result.status === 'installed') expect(result.testResult).toContain('test verified');
      expect(await readFile(join(f.input.worktreePath, 'package.json'), 'utf8')).toBe(manifest);
      expect(
        JSON.parse(await readFile(join(f.input.worktreePath, 'probe-counts.json'), 'utf8')),
      ).toEqual({ install: 1, test: 1 });
      console.info(
        'Native Linux sandbox: npm ci and npm test passed once; hook-only prepare omitted during install and restored before tests; auth, app key, parent proc credentials, and helper configuration protected.',
      );
    },
    60_000,
  );

  it.skipIf(
    process.platform !== 'linux' ||
      process.env.SANDY_NATIVE_SANDBOX_TEST !== '1' ||
      process.env.SANDY_NATIVE_REVIEW_WORKTREE === undefined,
  )(
    'runs the target checkout install and tests inside a protected linked Git worktree',
    async () => {
      const checkoutPath = process.env.SANDY_NATIVE_REVIEW_WORKTREE;
      if (checkoutPath === undefined || !isAbsolute(checkoutPath))
        throw new Error('SANDY_NATIVE_REVIEW_WORKTREE must be an absolute trusted checkout path');
      const f = await fixture(
        'throw new Error("Target checkout probe must use the installed Codex CLI");',
        process.env.RUNNER_TEMP ?? tmpdir(),
      );
      await rm(f.input.worktreePath, { recursive: true, force: true });
      await exec('git', ['worktree', 'add', '--detach', f.input.worktreePath, 'HEAD'], {
        cwd: checkoutPath,
      });
      try {
        const originalManifest = await readPackageJson(f.input.worktreePath);
        const protectedPaths = [
          ...['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'].flatMap(
            (key) => {
              const path = process.env[key];
              return path === undefined ? [] : [dirname(path)];
            },
          ),
          ...(process.env.GITHUB_APP_PRIVATE_KEY_PATH
            ? [process.env.GITHUB_APP_PRIVATE_KEY_PATH]
            : []),
          ...(process.env.SANDY_CONFIG_PATH ? [process.env.SANDY_CONFIG_PATH] : []),
          ...(process.env.SANDY_ROOT ? [join(process.env.SANDY_ROOT, '.config')] : []),
          ...(process.env.RUNNER_TEMP
            ? [join(process.env.RUNNER_TEMP, '_runner_file_commands')]
            : []),
        ];
        const runner = new CodexExecRunner({ codexHome: f.codexHome, protectedPaths });
        const result = await runner.installDependencies({ worktreePath: f.input.worktreePath });
        expect(
          (await readPackageJson(f.input.worktreePath)).bytes.equals(originalManifest.bytes),
        ).toBe(true);
        const boundedDiagnostic = (output: string) =>
          output.length <= 4000
            ? output
            : `${output.slice(0, 2000)}\n... [output truncated] ...\n${output.slice(-2000)}`;
        if (result.status === 'failed')
          throw new Error(
            `Native target dependency installation failed:\n${boundedDiagnostic(result.error)}`,
          );
        if (result.status !== 'installed' || result.testStatus !== 'passed')
          throw new Error(
            `Native target project tests did not pass:\n${boundedDiagnostic(
              result.status === 'installed'
                ? (result.testResult ?? 'No test diagnostics available.')
                : result.reason,
            )}`,
          );
        expect(result).toMatchObject({ status: 'installed', testStatus: 'passed' });
        console.info(
          'Native target checkout: dependency installation and the project test suite passed inside a protected linked Git worktree.',
        );
      } finally {
        await exec('git', ['worktree', 'remove', '--force', f.input.worktreePath], {
          cwd: checkoutPath,
        });
      }
    },
    26 * 60 * 1000,
  );

  it('keeps Linux process credential denials within their two-level procfs scan', async () => {
    const f = await fixture(`
      const args = process.argv.slice(2);
      const profile = args.find(value => value.startsWith('permissions.sandy='));
      if (!profile?.includes('"/proc/*/environ"="deny"') || !profile.includes('"/proc/*/mem"="deny"')) throw new Error('Missing process credential denials');
      if (!profile.includes('glob_scan_max_depth=2')) throw new Error('Recursive procfs scan reaches inaccessible fd and namespace directories');
      process.stdout.write('dependencies ready');
    `);
    await writeFile(join(f.input.worktreePath, 'package.json'), '{}');
    await writeFile(join(f.input.worktreePath, 'package-lock.json'), '{}');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const runner = new CodexExecRunner({ codexHome: f.codexHome, executable: f.executable });
      await expect(
        runner.installDependencies({ worktreePath: f.input.worktreePath }),
      ).resolves.toMatchObject({ status: 'installed', testStatus: 'skipped' });
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('installs dependencies with no credential environment and supplies one test-suite result to reviewers', async () => {
    const f = await fixture(`
      const args = process.argv.slice(2);
      if (args[0] !== 'sandbox') throw new Error('Install/test must be sandboxed');
      if (!(await import('node:fs')).existsSync(process.env.HOME)) throw new Error('Writable tool home must exist before Linux constructs its mounts');
      if (process.env.GH_TOKEN || process.env.CODEX_AUTH_JSON || process.env.SANDY_APP_PRIVATE_KEY) throw new Error('Credentials inherited');
      if (process.env.pnpm_config_verify_deps_before_run !== 'false' || process.env.pnpm_config_manage_package_manager_versions !== 'false') throw new Error('Test command could repeat dependency installation');
      if (process.env.CODEX_HOME.endsWith('/ci-codex')) throw new Error('Sandbox utility uses authenticated home');
      const command = args.at(-1);
      if (command.includes(' install ')) process.stdout.write('dependencies ready');
      else if (command === 'npx --yes pnpm@10.34.1 test') process.stdout.write('1 passed');
      else throw new Error('Unexpected command: ' + command);
    `);
    await writeFile(
      join(f.input.worktreePath, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.34.1', scripts: { test: 'vitest run' } }),
    );
    await writeFile(join(f.input.worktreePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    const runner = new CodexExecRunner({
      codexHome: f.codexHome,
      executable: f.executable,
      env: { GH_TOKEN: 'never-inherit', CODEX_AUTH_JSON: 'never-inherit' },
    });

    await expect(
      runner.installDependencies({ worktreePath: f.input.worktreePath }),
    ).resolves.toEqual({
      status: 'installed',
      packageManager: 'pnpm',
      command:
        'CI=true LEFTHOOK=0 HUSKY=0 npx --yes pnpm@10.34.1 install --frozen-lockfile --prefer-offline',
      durationMs: expect.any(Number),
      testStatus: 'passed',
      testResult: 'npx --yes pnpm@10.34.1 test exited 0.\n1 passed',
    });
  });
});
