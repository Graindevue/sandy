import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PIN = '0.162.0';

/** Exercise the actual pinned binary; all provider responses and credentials are disposable. */
export async function runCompatibilityProbe(executable = 'codex') {
  const { stdout: version } = await exec(executable, ['--version'], { timeout: 10_000 });
  assert.equal(version.trim(), `codex-cli ${PIN}`, 'The deployed CLI pin must be tested exactly');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-runtime-probe-')));
  const runtimeHome = join(root, 'runtime');
  const seed = join(root, 'seed');
  const siblings = join(root, 'sibling');
  const agentsRoot = join(root, 'agents');
  const workspaces = [join(agentsRoot, 'logic'), join(agentsRoot, 'security')];
  const repository = join(root, 'repository');
  const metadata = join(repository, '.git');
  let child;
  let closed;
  let failure;
  let stderr = '';
  let nextId = 0;
  const replies = new Map();
  const notifications = [];
  const pending = [];
  const fail = (error) => {
    failure ??= error;
    for (const reply of replies.values()) reply.reject(failure);
    replies.clear();
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000, 'Mock provider request must remain bounded');
        chunks.push(chunk);
      }
      assert.equal(
        request.headers.authorization,
        undefined,
        'The probe must never send credentials',
      );
      if (request.url !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      pending.push({ response, body: JSON.parse(Buffer.concat(chunks).toString()) });
    } catch (error) {
      fail(error);
      response.destroy();
    }
  });
  const timer = setTimeout(() => {
    fail(new Error('Compatibility probe exceeded its 90-second budget'));
    child?.kill('SIGKILL');
  }, 90_000);
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (failure !== undefined) throw failure;
      assert.ok(Date.now() < deadline, `Timed out awaiting ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const request = (method, params) => {
    if (failure !== undefined) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const respond = (entry, items, usage) => {
    entry.response.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `fixture-${pending.indexOf(entry)}`;
    const events = [
      { type: 'response.created', response: { id } },
      ...items.map((item) => ({ type: 'response.output_item.done', item })),
      { type: 'response.completed', response: { id, usage } },
    ];
    for (const event of events) entry.response.write(`data: ${JSON.stringify(event)}\n\n`);
    entry.response.end();
  };
  const finish = (entry, text, input, cached, output) =>
    respond(
      entry,
      [
        {
          type: 'message',
          role: 'assistant',
          id: `message-${text}`,
          content: [{ type: 'output_text', text }],
        },
      ],
      {
        input_tokens: input,
        input_tokens_details: { cached_tokens: cached },
        output_tokens: output,
        total_tokens: input + output,
      },
    );
  const terminal = (threadId, turnId) =>
    notifications.find(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.threadId === threadId &&
        event.params.turn.id === turnId,
    );
  try {
    await mkdir(runtimeHome);
    await mkdir(siblings);
    await writeFile(join(runtimeHome, 'credential-canary.txt'), 'DISPOSABLE_CREDENTIAL_CANARY');
    await writeFile(join(siblings, 'source.txt'), 'pinned sibling');
    await exec('git', ['init', '--initial-branch=main', repository]);
    await writeFile(join(repository, 'README.md'), 'pinned source\n');
    await exec('git', ['-C', repository, 'add', '.']);
    await exec('git', [
      '-C',
      repository,
      '-c',
      'user.name=Probe',
      '-c',
      'user.email=probe@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    const { stdout: shaText } = await exec('git', ['-C', repository, 'rev-parse', 'HEAD']);
    const sha = shaText.trim();
    await exec('git', ['-C', repository, 'worktree', 'add', '--detach', seed, sha]);
    await mkdir(agentsRoot);
    for (const workspace of workspaces) {
      await cp(seed, workspace, { recursive: true, dereference: false, verbatimSymlinks: true });
      await mkdir(join(workspace, '.home'));
      await mkdir(join(workspace, '.tmp'));
      await mkdir(join(workspace, '.codex'));
      await writeFile(join(workspace, 'peer-canary.txt'), 'DISPOSABLE_PEER_CANARY');
      await writeFile(
        join(workspace, '.codex/config.toml'),
        'model = "hostile-project-model"\n[permissions.sandy.filesystem]\n":root" = "write"\n',
      );
      const peer = workspaces.find((path) => path !== workspace);
      await writeFile(
        join(workspace, 'tool-probe.cjs'),
        `const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const agent = process.argv[2];
for (const path of [process.cwd(), process.env.HOME, process.env.TMPDIR]) fs.writeFileSync(join(path, 'artifact.txt'), agent);
assert.throws(() => fs.readFileSync(${JSON.stringify(join(runtimeHome, 'credential-canary.txt'))}));
assert.throws(() => fs.readFileSync(${JSON.stringify(join(peer, 'peer-canary.txt'))}));
assert.throws(() => fs.writeFileSync(${JSON.stringify(join(peer, 'intrusion.txt'))}, 'BAD'));
assert.equal(fs.readFileSync(${JSON.stringify(join(siblings, 'source.txt'))}, 'utf8'), 'pinned sibling');
assert.throws(() => fs.writeFileSync(${JSON.stringify(join(siblings, 'source.txt'))}, 'BAD'));
assert.throws(() => fs.writeFileSync(${JSON.stringify(join(seed, 'README.md'))}, 'BAD'));
assert.throws(() => fs.appendFileSync(${JSON.stringify(join(metadata, 'config'))}, 'BAD'));
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim(), ${JSON.stringify(sha)});
console.log('PROBE_OK:' + agent);
`,
      );
    }
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await writeFile(
      join(runtimeHome, 'config.toml'),
      `model = "mock-model"
model_provider = "probe"
approval_policy = "never"
cli_auth_credentials_store = "file"
[features]
shell_snapshot = false
multi_agent = false
[model_providers.probe]
name = "Credential-free compatibility fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
    );
    child = spawn(executable, ['app-server', '--listen', 'stdio://', '--strict-config'], {
      cwd: root,
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        HOME: root,
        CODEX_HOME: runtimeHome,
        USER: process.env.USER ?? 'probe',
        LANG: 'C.UTF-8',
      },
      stdio: 'pipe',
    });
    closed = new Promise((resolve) =>
      child.once('close', (code) => {
        fail(new Error(`Probe runtime closed (${code})`));
        resolve(code);
      }),
    );
    child.once('error', fail);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-65_536);
    });
    let eventBytes = 0;
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        eventBytes += line.length;
        assert.ok(eventBytes < 4_000_000, 'Protocol events must remain bounded');
        const event = JSON.parse(line);
        if (event.id !== undefined && replies.has(event.id)) {
          const reply = replies.get(event.id);
          replies.delete(event.id);
          if (event.error !== undefined) reply.reject(new Error(JSON.stringify(event.error)));
          else reply.resolve(event.result);
        } else if (event.method !== undefined) notifications.push(event);
      } catch (error) {
        fail(error);
        child.kill('SIGKILL');
      }
    });
    await request('initialize', {
      clientInfo: { name: 'sandy-compatibility-probe', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const resolver = process.platform === 'linux' ? await realpath('/etc/resolv.conf') : undefined;
    const threads = await Promise.all(
      workspaces.map((workspace) =>
        request('thread/start', {
          model: 'mock-model',
          modelProvider: 'probe',
          cwd: workspace,
          runtimeWorkspaceRoots: [workspace],
          permissions: 'sandy',
          approvalPolicy: 'never',
          ephemeral: true,
          config: {
            'permissions.sandy': {
              filesystem: {
                ...(process.platform === 'linux'
                  ? {
                      ':minimal': 'read',
                      '/opt': 'read',
                      [resolver]: 'read',
                      glob_scan_max_depth: 2,
                      '/proc/*/environ': 'deny',
                      '/proc/*/mem': 'deny',
                    }
                  : { ':root': 'read' }),
                [workspaces.find((path) => path !== workspace)]: 'deny',
                [workspace]: 'write',
                [runtimeHome]: 'deny',
                [seed]: 'read',
                [siblings]: 'read',
                [metadata]: 'read',
              },
              network: { enabled: true },
            },
            projects: { [workspace]: { trust_level: 'untrusted' } },
            'shell_environment_policy.inherit': 'core',
            'shell_environment_policy.experimental_use_profile': false,
            'shell_environment_policy.set': {
              HOME: join(workspace, '.home'),
              TMPDIR: join(workspace, '.tmp'),
              OPENSRC_HOME: join(workspace, '.home/opensrc'),
            },
          },
        }),
      ),
    );
    assert.notEqual(threads[0].thread.id, threads[1].thread.id);
    for (const [index, thread] of threads.entries()) {
      assert.equal(
        thread.model,
        'mock-model',
        'Untrusted project configuration must remain disabled',
      );
      assert.equal(thread.cwd, workspaces[index]);
      assert.equal(thread.approvalPolicy, 'never');
      assert.equal(thread.activePermissionProfile.id, 'sandy');
    }
    const turns = await Promise.all(
      threads.map((thread, index) =>
        request('turn/start', {
          threadId: thread.thread.id,
          effort: index === 0 ? 'high' : 'medium',
          input: [{ type: 'text', text: `START_${index}`, text_elements: [] }],
        }),
      ),
    );
    await waitFor(
      () => pending.length === 2,
      'both concurrent provider requests before either response',
    );
    const entries = threads.map((_, index) =>
      pending.find((entry) => JSON.stringify(entry.body.input).includes(`START_${index}`)),
    );
    assert.equal(entries[0].body.reasoning.effort, 'high');
    assert.equal(entries[1].body.reasoning.effort, 'medium');
    finish(entries[1], 'security-result', 200, 40, 25);
    await waitFor(() => terminal(threads[1].thread.id, turns[1].turn.id), 'security terminal');
    assert.equal(terminal(threads[0].thread.id, turns[0].turn.id), undefined);
    finish(entries[0], 'logic-result', 100, 10, 15);
    await waitFor(() => terminal(threads[0].thread.id, turns[0].turn.id), 'logic terminal');
    const usage = threads.map(
      (thread) =>
        notifications.findLast(
          (event) =>
            event.method === 'thread/tokenUsage/updated' &&
            event.params.threadId === thread.thread.id,
        ).params.tokenUsage.total,
    );
    assert.equal(usage[0].inputTokens, 100);
    assert.equal(usage[0].cachedInputTokens, 10);
    assert.equal(usage[0].outputTokens, 15);
    assert.equal(usage[1].inputTokens, 200);
    assert.equal(usage[1].cachedInputTokens, 40);
    assert.equal(usage[1].outputTokens, 25);
    const toolTurns = await Promise.all(
      threads.map((thread, index) =>
        request('turn/start', {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: `TOOL_${index}`, text_elements: [] }],
        }),
      ),
    );
    await waitFor(() => pending.length === 4, 'both tool turns');
    for (const [index, workspace] of workspaces.entries()) {
      const entry = pending
        .slice(2)
        .find((entry) => JSON.stringify(entry.body.input).includes(`TOOL_${index}`));
      const agent = index === 0 ? 'logic' : 'security';
      respond(
        entry,
        [
          {
            type: 'function_call',
            call_id: `tool-${agent}`,
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: `node tool-probe.cjs ${agent}`,
              workdir: workspace,
              yield_time_ms: 1000,
              max_output_tokens: 1000,
            }),
          },
        ],
        { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      );
    }
    await waitFor(() => pending.length === 6, 'sandboxed commands and continuation requests');
    const toolEvents = notifications.filter(
      (event) => event.method === 'item/completed' && event.params.item.type === 'commandExecution',
    );
    assert.equal(
      toolEvents.length,
      2,
      JSON.stringify(
        pending
          .slice(4)
          .map((entry) => entry.body.input.filter((item) => item.type === 'function_call_output')),
      ).slice(0, 3000),
    );
    for (const [index, thread] of threads.entries()) {
      const item = toolEvents.find((event) => event.params.threadId === thread.thread.id).params
        .item;
      assert.equal(
        item.exitCode,
        0,
        `Sandbox canary assertions failed: ${item.aggregatedOutput.slice(0, 2000)}`,
      );
      assert.match(
        item.aggregatedOutput,
        new RegExp(`PROBE_OK:${index === 0 ? 'logic' : 'security'}`),
      );
    }
    for (const entry of pending.slice(4)) finish(entry, 'tool-complete', 10, 0, 1);
    await waitFor(
      () => threads.every((thread, index) => terminal(thread.thread.id, toolTurns[index].turn.id)),
      'both tool terminals',
    );
    for (const [index, workspace] of workspaces.entries()) {
      for (const directory of [workspace, join(workspace, '.home'), join(workspace, '.tmp')]) {
        assert.equal(
          await readFile(join(directory, 'artifact.txt'), 'utf8'),
          index === 0 ? 'logic' : 'security',
        );
      }
    }
    const cancel = await request('turn/start', {
      threadId: threads[0].thread.id,
      input: [{ type: 'text', text: 'CANCEL', text_elements: [] }],
    });
    await waitFor(() => pending.length === 7, 'held cancellation turn');
    await request('turn/interrupt', { threadId: threads[0].thread.id, turnId: cancel.turn.id });
    await waitFor(() => terminal(threads[0].thread.id, cancel.turn.id), 'interrupted terminal');
    assert.equal(terminal(threads[0].thread.id, cancel.turn.id).params.turn.status, 'interrupted');
    child.stdin.end();
    assert.equal(await closed, 0, 'Runtime must close cleanly before workspaces are removed');
    return {
      version: PIN,
      platform: process.platform,
      architecture: process.arch,
      provider: 'credential-free mock',
      concurrentTurns: true,
      threadEventRouting: true,
      syntheticUsage: usage,
      cancellation: true,
      privateWorkspaceHomeTemp: true,
      credentialAndPeerDenial: true,
      seedSiblingGitReadOnly: true,
      untrustedProjectConfig: true,
      drainedClose: true,
      liveAuthRefresh: 'not-tested',
      realModelQualityAndLatency: 'not-tested',
    };
  } catch (error) {
    if (stderr.length > 0)
      error.message += ` (runtime stderr retained ${stderr.length} bytes; no raw transcript saved)`;
    throw error;
  } finally {
    clearTimeout(timer);
    child?.kill('SIGKILL');
    if (closed !== undefined) await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCompatibilityProbe(process.argv[2] ?? 'codex');
  if (process.argv[3] !== undefined)
    await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.info(JSON.stringify(result, null, 2));
}
