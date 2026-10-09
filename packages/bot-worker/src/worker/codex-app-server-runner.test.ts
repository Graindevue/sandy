import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentDefinition } from '@sandy/shared-types';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRunner } from './codex-app-server-runner.js';
import type { RunAgentInput } from './codex-exec-runner.js';

const directories: string[] = [];
const protocolFixture = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.162.0'); process.exit(0); }
if (args.includes('generate-json-schema')) {
  const out = args[args.indexOf('--out') + 1];
  fs.mkdirSync(path.join(out, 'v2'), { recursive: true });
  for (const [name, fields] of Object.entries({
    ThreadStartParams: ['permissions','runtimeWorkspaceRoots','config','ephemeral'],
    TurnStartParams: ['threadId','input','effort','permissions'],
    ThreadTokenUsageUpdatedNotification: ['threadId','turnId','tokenUsage'],
    TurnCompletedNotification: ['threadId','turn'],
    TurnInterruptParams: ['threadId','turnId'],
    ThreadBackgroundTerminalsCleanParams: ['threadId'],
  })) fs.writeFileSync(path.join(out,'v2',name+'.json'), JSON.stringify({properties: Object.fromEntries(fields.map(k=>[k,{}])), ...(name==='ThreadTokenUsageUpdatedNotification'?{definitions:{TokenUsageBreakdown:{properties:{inputTokens:{},cachedInputTokens:{},cacheWriteInputTokens:{},outputTokens:{}}}}}:{})}));
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id,result) => send({id,result});
let nextThread = 0;
const turns = [];
require('node:readline').createInterface({input:process.stdin}).on('line',line=> {
  const {id,method,params} = JSON.parse(line);
  if (method === 'initialize') reply(id,{userAgent:'codex/0.162.0'});
  if (method === 'thread/start') reply(id,{thread:{id:'thread-'+ ++nextThread},cwd:params.cwd,runtimeWorkspaceRoots:params.runtimeWorkspaceRoots,approvalPolicy:'never',activePermissionProfile:{id:'sandy'}});
  if (method === 'thread/backgroundTerminals/clean') reply(id,{});
  if (method === 'turn/start') {
    turns.push({id,params});
    if (turns.length === 2) for (const [index, entry] of [...turns].reverse().entries()) {
      const turnId = 'turn-'+ entry.params.threadId;
      const total = {inputTokens:index===0?200:100,cachedInputTokens:index===0?40:10,cacheWriteInputTokens:0,outputTokens:index===0?25:15};
      const text = '<findings>'+entry.params.threadId+'</findings>';
      send({method:'thread/tokenUsage/updated',params:{threadId:entry.params.threadId,turnId,tokenUsage:{total,last:total}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:entry.params.threadId,turnId,tokenUsage:{total,last:total}}});
      send({method:'item/completed',params:{threadId:entry.params.threadId,turnId,item:{type:'agentMessage',text}}});
      send({method:'turn/completed',params:{threadId:entry.params.threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text}]}}});
      reply(entry.id,{turn:{id:turnId}});
    }
  }
});
`;
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function executable(program: string) {
  const root = await mkdtemp(join(tmpdir(), 'sandy-app-server-'));
  directories.push(root);
  const path = join(root, 'codex');
  await writeFile(path, `#!/usr/bin/env node\n${program}`);
  await chmod(path, 0o755);
  return { root, path, codexHome: join(root, 'auth') };
}

const agent: AgentDefinition = {
  key: 'logic',
  name: 'Logic',
  description: 'Find bugs',
  category: 'logic',
  vendor: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'xhigh',
  tools: [],
  maxIterations: 30,
  completionSignal: '</findings>',
  defaultEnabled: true,
  systemPrompt: 'Find concrete bugs.',
};
const exec = promisify(execFile);
async function workspaces(root: string): Promise<{ seed: string; inputs: RunAgentInput[] }> {
  const seed = join(root, 'seed');
  await mkdir(seed);
  await exec('git', ['init', '-b', 'main'], { cwd: seed });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: seed });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: seed });
  await writeFile(join(seed, 'review.ts'), 'export const before = true;\n');
  await exec('git', ['add', '.'], { cwd: seed });
  await exec('git', ['commit', '-m', 'base'], { cwd: seed });
  await exec('git', ['remote', 'add', 'origin', seed], { cwd: seed });
  await exec('git', ['checkout', '-b', 'feature'], { cwd: seed });
  await writeFile(join(seed, 'review.ts'), 'export const after = false;\n');
  await exec('git', ['commit', '-am', 'change'], { cwd: seed });
  await exec('git', ['fetch', 'origin'], { cwd: seed });
  const headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
  const inputs = await Promise.all(
    ['logic', 'security'].map(async (key) => {
      const worktreePath = join(root, 'agents', key);
      await cp(seed, worktreePath, { recursive: true });
      return {
        agent: { ...agent, key, systemPrompt: `${key.toUpperCase()}_PROMPT` },
        worktreePath,
        pullRequest: {
          owner: 'acme',
          repo: 'widget',
          number: 42,
          headSha,
          baseRef: 'main',
          title: 'Fix',
          url: 'https://github.com/acme/widget/pull/42',
        },
      };
    }),
  );
  return { seed, inputs };
}

describe('CodexAppServerRunner Review runtime lifecycle', () => {
  it('retains logical and physical protected paths for native symlink validation', async () => {
    const f = await executable('');
    const w = await workspaces(f.root);
    const target = join(f.root, 'protected-target');
    const alias = join(f.root, 'protected-alias');
    await mkdir(target);
    await symlink(target, alias);
    const protectedPaths = [alias, await realpath(target)];
    await writeFile(
      f.path,
      `#!/usr/bin/env node\n${protocolFixture.replace(
        "if (method === 'thread/start') reply(id,",
        `if (method === 'thread/start' && !${JSON.stringify(protectedPaths)}.every(path => params.config['permissions.sandy'].filesystem[path] === 'deny')) throw new Error('Native symlink protection was removed');
      if (method === 'thread/start') reply(id,`,
      )}`,
    );
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
      protectedPaths: [alias],
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    try {
      const results = await Promise.all(w.inputs.map((input) => runtime.runAgent(input)));
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.stdout.includes('<findings>'))).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('keeps the prepared seed and peer workspaces protected in serial rollback', async () => {
    const f = await executable('');
    const w = await workspaces(f.root);
    const current = w.inputs[0];
    const peer = w.inputs[1];
    if (current === undefined || peer === undefined) throw new Error('Missing fixture Agents');
    await mkdir(f.codexHome);
    await writeFile(
      f.path,
      `#!/usr/bin/env node
      import { realpathSync } from 'node:fs';
      const args = process.argv.slice(2);
      const config = args.find(arg=>arg.startsWith('permissions.sandy='));
      for (const protectedPath of ${JSON.stringify([w.seed, peer.worktreePath])}) {
        if (!config?.includes(JSON.stringify(realpathSync(protectedPath))+'="deny"')) throw new Error('Serial rollback exposes another workspace');
      }
      if (config.includes(JSON.stringify(${JSON.stringify(current.worktreePath)})+'="deny"')) throw new Error('Own workspace cannot be denied');
      for await (const chunk of process.stdin) {}
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'<findings>protected</findings>'}})+'\\n');
    `,
    );
    const runner = new CodexAppServerRunner({ codexHome: f.codexHome, executable: f.path });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 1,
    });
    try {
      const result = await runtime.runAgent(current);
      expect(result.stdout).toBe('<findings>protected</findings>');
    } finally {
      await runtime.close();
    }
  });

  it('keeps parallel execution disabled until explicitly opted in', async () => {
    const f = await executable('throw new Error("Runtime must not start");');
    const runner = new CodexAppServerRunner({ codexHome: f.codexHome, executable: f.path });
    const runtime = await runner.openReview({ worktreePath: f.root, maxConcurrency: 3 });
    expect(runtime.mode).toBe('serial');
    expect(runtime.maxConcurrency).toBe(1);
    await runtime.close();
  });

  it('admits an explicitly enabled compatible pinned managed runtime', async () => {
    const f = await executable(protocolFixture);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({ worktreePath: f.root, maxConcurrency: 3 });
    expect(runtime.mode).toBe('parallel');
    expect(runtime.maxConcurrency).toBe(3);
    await runtime.close();
  });

  it('routes concurrent fresh threads and cumulative usage despite reversed early completion', async () => {
    const f = await executable(protocolFixture);
    const w = await workspaces(f.root);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 3,
    });
    try {
      const results = await Promise.all(w.inputs.map((input) => runtime.runAgent(input)));
      expect(new Set(results.map((result) => result.stdout)).size).toBe(2);
      expect(results.map((result) => result.usage)).toEqual(
        expect.arrayContaining([
          {
            inputTokens: 90,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 0,
            outputTokens: 15,
          },
          {
            inputTokens: 160,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 0,
            outputTokens: 25,
          },
        ]),
      );
      expect(runtime.failureSignal?.aborted).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it.each([
    'missing',
    'null',
  ])('accepts %s optional cached counters without aborting peer turns', async (variant) => {
    const f = await executable(
      protocolFixture.replace(
        'cachedInputTokens:index===0?40:10,cacheWriteInputTokens:0,',
        variant === 'null' ? 'cachedInputTokens:null,cacheWriteInputTokens:null,' : '',
      ),
    );
    const w = await workspaces(f.root);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    try {
      const results = await Promise.all(w.inputs.map((input) => runtime.runAgent(input)));
      expect(results.map((result) => result.usage)).toEqual(
        expect.arrayContaining([
          {
            inputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 15,
          },
          {
            inputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 25,
          },
        ]),
      );
      expect(runtime.failureSignal?.aborted).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('interrupts only the cancelled thread, drains its usage, and preserves its successful peer', async () => {
    const f = await executable(`${protocolFixture
      .replace('if (turns.length === 2)', 'if (false)')
      .replace(
        "if (method === 'thread/backgroundTerminals/clean') reply(id,{});",
        `if (method === 'thread/backgroundTerminals/clean') {
        send({method:'thread/tokenUsage/updated',params:{threadId:params.threadId,turnId:'turn-'+params.threadId,tokenUsage:{total:{inputTokens:60,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:9}}}});
        reply(id,{});
      }`,
      )}
    require('node:readline').createInterface({input:process.stdin}).on('line',line=> {
      const {id,method,params} = JSON.parse(line);
      if (method === 'turn/start') {
        const turnId = 'turn-'+params.threadId;
        reply(id,{turn:{id:turnId}});
        if (turns.length === 2) {
          const peer = turns.find(entry => entry.params.input[0].text.startsWith('SECURITY_PROMPT'));
          send({method:'turn/completed',params:{threadId:peer.params.threadId,turn:{id:'turn-'+peer.params.threadId,status:'completed',items:[{type:'agentMessage',text:'<findings>peer</findings>'}]}}});
        }
      }
      if (method === 'turn/interrupt') {
        send({method:'thread/tokenUsage/updated',params:{threadId:params.threadId,turnId:params.turnId,tokenUsage:{total:{inputTokens:50,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:7}}}});
        send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted',items:[]}}});
        reply(id,{});
      }
    });`);
    const w = await workspaces(f.root);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    const controller = new AbortController();
    try {
      const input = w.inputs[0];
      const peer = w.inputs[1];
      if (input === undefined || peer === undefined) throw new Error('Missing fixture Agents');
      const cancelled = runtime.runAgent({ ...input, signal: controller.signal });
      const outcome = cancelled.catch((error: unknown) => error);
      const successful = await runtime.runAgent(peer);
      controller.abort(new Error('Cancelled Agent'));
      expect(await outcome).toMatchObject({
        usage: {
          inputTokens: 55,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 0,
          outputTokens: 9,
        },
      });
      expect(successful.stdout).toBe('<findings>peer</findings>');
      expect(runtime.failureSignal?.aborted).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('returns authoritative usage received after terminal completion while cleaning child tools', async () => {
    const f = await executable(
      protocolFixture.replace(
        "if (method === 'thread/backgroundTerminals/clean') reply(id,{});",
        `if (method === 'thread/backgroundTerminals/clean') setTimeout(() => {
        const total = {inputTokens:300,cachedInputTokens:20,cacheWriteInputTokens:30,outputTokens:40};
        send({method:'thread/tokenUsage/updated',params:{threadId:params.threadId,turnId:'turn-'+params.threadId,tokenUsage:{total}}});
        reply(id,{});
      },10);`,
      ),
    );
    const w = await workspaces(f.root);
    const runtime = await new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    }).openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    try {
      const results = await Promise.all(w.inputs.map((input) => runtime.runAgent(input)));
      expect(results.map((result) => result.usage)).toEqual([
        {
          inputTokens: 250,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
          outputTokens: 40,
        },
        {
          inputTokens: 250,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
          outputTokens: 40,
        },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('falls back before Agent execution if the pin or required schema is incompatible', async () => {
    for (const program of [
      protocolFixture.replace('codex-cli 0.162.0', 'codex-cli 0.161.0'),
      protocolFixture.replace("['threadId','turnId','tokenUsage']", "['threadId']"),
    ]) {
      const f = await executable(program);
      const messages: string[] = [];
      const runner = new CodexAppServerRunner({
        codexHome: f.codexHome,
        executable: f.path,
        enableManagedRuntime: true,
        logger: { info: (message) => messages.push(message) },
      });
      const runtime = await runner.openReview({ worktreePath: f.root, maxConcurrency: 3 });
      expect(runtime.mode).toBe('serial');
      expect(runtime.maxConcurrency).toBe(1);
      expect(messages).toEqual([
        expect.stringContaining('unavailable before Agent execution; using serial mode'),
      ]);
      await runtime.close();
    }
  });

  it.each([
    { items: [{ type: 'webSearch' }], count: 1 },
    { items: [{ type: 'commandExecution', durationMs: 7 }, { type: 'webSearch' }], count: 2 },
  ])('keeps tool duration unknown when completed tools omit it: $count tools', async ({
    items,
    count,
  }) => {
    const f = await executable(
      protocolFixture.replace(
        "const text = '<findings>'+entry.params.threadId+'</findings>';",
        `const text = '<findings>'+entry.params.threadId+'</findings>';
      for (const item of ${JSON.stringify(items)}) send({method:'item/completed',params:{threadId:entry.params.threadId,turnId,item}});`,
      ),
    );
    const w = await workspaces(f.root);
    const runtime = await new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    }).openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    try {
      const results = await Promise.all(w.inputs.map((input) => runtime.runAgent(input)));
      expect(results.map((result) => result.activity)).toEqual([
        { toolCount: count },
        { toolCount: count },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('retains a completed thread while a runtime crash fails affected peers without restarting', async () => {
    const f = await executable(`${protocolFixture.replace('if (turns.length === 2)', 'if (false)')}
    require('node:readline').createInterface({input:process.stdin}).on('line',line=> {
      const {id,method,params} = JSON.parse(line);
      if (method === 'turn/start') {
        reply(id,{turn:{id:'turn-'+params.threadId}});
        if (turns.length === 2) {
          const done = turns.find(entry => entry.params.input[0].text.startsWith('SECURITY_PROMPT'));
          send({method:'turn/completed',params:{threadId:done.params.threadId,turn:{id:'turn-'+done.params.threadId,status:'completed',items:[{type:'agentMessage',text:'<findings>preserved</findings>'}]}}});
        }
      }
      if (method === 'thread/backgroundTerminals/clean') setImmediate(()=>process.exit(1));
    });`);
    const w = await workspaces(f.root);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 2,
    });
    try {
      const results = await Promise.allSettled(w.inputs.map((input) => runtime.runAgent(input)));
      expect(results).toEqual(
        expect.arrayContaining([
          {
            status: 'fulfilled',
            value: {
              stdout: '<findings>preserved</findings>',
            },
          },
          expect.objectContaining({ status: 'rejected' }),
        ]),
      );
      expect(runtime.failureSignal?.aborted).toBe(true);
      const input = w.inputs[0];
      if (input === undefined) throw new Error('Missing fixture Agent');
      await expect(runtime.runAgent(input)).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });

  it('continues an incomplete result once in the same thread without double-counting usage', async () => {
    const f = await executable(`${protocolFixture.replace('if (turns.length === 2)', 'if (false)')}
    require('node:readline').createInterface({input:process.stdin}).on('line',line=> {
      const {id,method,params} = JSON.parse(line);
      if (method === 'thread/start') {
        const profile = params.config['permissions.sandy'].filesystem;
        if (profile[':tmpdir'] || profile[':slash_tmp']) throw new Error('Shared temp writes forbidden');
        const environment = params.config['shell_environment_policy.set'];
        if (!environment.HOME.startsWith(params.cwd+'/') || !environment.TMPDIR.startsWith(params.cwd+'/')) throw new Error('Tool home must be private');
      }
      if (method === 'turn/start') {
        if (params.model !== 'gpt-6.1-sol' || params.effort !== 'xhigh') throw new Error('Persona configuration changed');
        if (nextThread !== 1 || turns.length > 2) throw new Error('Investigation was restarted');
        if (turns.length === 2 && !params.input[0].text.includes('Do not repeat your investigation')) throw new Error('Recovery must only finish output');
        const turnId = 'turn-'+turns.length;
        const total = turns.length === 1 ? {inputTokens:100,cachedInputTokens:10,cacheWriteInputTokens:0,outputTokens:15} : {inputTokens:140,cachedInputTokens:14,cacheWriteInputTokens:60,outputTokens:20};
        send({method:'thread/tokenUsage/updated',params:{threadId:params.threadId,turnId,tokenUsage:{total}}});
        send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:turns.length===1?'unfinished':'<findings>recovered</findings>'}]}}});
        reply(id,{turn:{id:turnId}});
      }
    });`);
    const w = await workspaces(f.root);
    const runner = new CodexAppServerRunner({
      codexHome: f.codexHome,
      executable: f.path,
      enableManagedRuntime: true,
    });
    const runtime = await runner.openReview({
      worktreePath: w.seed,
      privateWorkspacePaths: w.inputs.map((input) => input.worktreePath),
      maxConcurrency: 3,
    });
    try {
      const input = w.inputs[0];
      if (input === undefined) throw new Error('Missing fixture Agent');
      const result = await runtime.runAgent(input);
      expect(result.stdout).toBe('<findings>recovered</findings>');
      expect(result.usage).toEqual({
        inputTokens: 66,
        cacheReadInputTokens: 14,
        cacheCreationInputTokens: 60,
        outputTokens: 20,
      });
    } finally {
      await runtime.close();
    }
  });
});
