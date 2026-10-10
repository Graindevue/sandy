import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const exec = promisify(execFile);
const sandyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Native turns against anonymous or synthetic ChatGPT loopback fixtures; no live login/model. */
export async function runManagedRuntimeProbe(
  executable = 'codex',
  workspaceRouting = false,
  stagedInventory = false,
) {
  const { CodexAppServerRunner } = await import(
    join(sandyRoot, 'packages/bot-worker/dist/worker/codex-app-server-runner.js')
  );
  const { AgentRunError, agentRunFailure } = await import(
    join(sandyRoot, 'packages/bot-worker/dist/worker/review-errors.js')
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-managed-probe-')));
  const auth = join(root, 'auth');
  const seed = join(root, 'seed');
  const keys = ['logic', 'security', 'framework'];
  const pending = [];
  const responded = new Set();
  let clones;
  let workspaces;
  let runtime;
  let providerFailure;
  let backendOrigin;
  let fixtureToken;
  let fixtureCertificate;
  let routingRequests = 0;
  let paths;
  const sendEvents = (response, events) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const handleRequest = async (request, response) => {
    try {
      if (workspaceRouting && request.headers.authorization !== undefined)
        assert.ok(request.headers.authorization === `Bearer ${fixtureToken}`);
      else if (request.headers.authorization !== undefined)
        throw new Error('Anonymous fixture received credentials');
      if (workspaceRouting && request.url === '/backend-api/wham/accounts/check') {
        routingRequests++;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            accounts: [
              {
                id: 'synthetic-account',
                workspace_backend_origin: backendOrigin,
                account_routing_override: 'NO_CONSTRAINT',
              },
            ],
          }),
        );
        return;
      }
      if (workspaceRouting && request.url === '/backend-api/wham/config/bundle') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.url !== (workspaceRouting ? '/backend-api/codex/responses' : '/v1/responses')) {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000, 'Fixture request exceeded bound');
        chunks.push(chunk);
      }
      const bytesReceived = Buffer.concat(chunks);
      assert.ok(
        request.headers['content-encoding'] === undefined ||
          request.headers['content-encoding'] === 'zstd',
        'Unsupported fixture request encoding',
      );
      const body = JSON.parse(
        (request.headers['content-encoding'] === 'zstd'
          ? zstdDecompressSync(bytesReceived, { maxOutputLength: 2_000_000 })
          : bytesReceived
        ).toString(),
      );
      const index = keys.findIndex((key) =>
        JSON.stringify(body.input).includes(`NATIVE_PROBE_${key}`),
      );
      assert.ok(index >= 0, 'Unexpected native probe persona');
      if (workspaceRouting) {
        const toolOutputs = body.input.filter((item) => item.type === 'function_call_output');
        if (toolOutputs.length === 0) {
          const id = `sandbox-${index}`;
          sendEvents(response, [
            { type: 'response.created', response: { id } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                call_id: id,
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'node routing-tool-probe.cjs',
                  workdir: paths[index],
                  yield_time_ms: 1000,
                  max_output_tokens: 1000,
                }),
              },
            },
            {
              type: 'response.completed',
              response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
            },
          ]);
          return;
        }
        assert.equal(toolOutputs.length, 1);
        assert.ok(
          JSON.stringify(toolOutputs[0]).includes(`ROUTING_SANDBOX_OK:${keys[index]}`),
          'Retained workspace profile must enforce its sandbox',
        );
      }
      pending.push({ response, index });
      if (pending.length >= (stagedInventory ? 2 : keys.length))
        for (const entry of [...pending].reverse()) {
          if (responded.has(entry.index)) continue;
          responded.add(entry.index);
          const id = `fixture-${entry.index}`;
          const events = [
            { type: 'response.created', response: { id } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'message',
                role: 'assistant',
                id: `message-${entry.index}`,
                content: [
                  { type: 'output_text', text: `<findings>${keys[entry.index]}</findings>` },
                ],
              },
            },
            {
              type: 'response.completed',
              response: {
                id,
                usage: {
                  input_tokens: 100 * (entry.index + 1),
                  input_tokens_details: { cached_tokens: 10 * (entry.index + 1) },
                  output_tokens: 15 * (entry.index + 1),
                  total_tokens: 115 * (entry.index + 1),
                },
              },
            },
          ];
          sendEvents(entry.response, events);
        }
    } catch (error) {
      providerFailure = error;
      response.destroy();
    }
  };
  let server = createServer(handleRequest);
  let nativeExecutable = executable;
  let stopped = true;
  try {
    const version = (await exec(executable, ['--version'], { timeout: 10_000 })).stdout.trim();
    assert.equal(version, 'codex-cli 0.162.0');
    await mkdir(auth);
    await mkdir(seed);
    if (workspaceRouting) {
      const key = join(root, 'fixture.key');
      const certificate = join(root, 'fixture.pem');
      fixtureCertificate = certificate;
      const leafKey = join(root, 'server.key');
      const leafCertificate = join(root, 'server.pem');
      const request = join(root, 'server.csr');
      const extensions = join(root, 'server.ext');
      await exec(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          certificate,
          '-days',
          '1',
          '-subj',
          '/CN=Synthetic probe CA',
          '-addext',
          'basicConstraints=critical,CA:TRUE',
        ],
        { timeout: 10_000 },
      );
      await exec(
        'openssl',
        [
          'req',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          leafKey,
          '-out',
          request,
          '-subj',
          '/CN=localhost',
        ],
        { timeout: 10_000 },
      );
      await writeFile(
        extensions,
        'basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
      );
      await exec(
        'openssl',
        [
          'x509',
          '-req',
          '-in',
          request,
          '-CA',
          certificate,
          '-CAkey',
          key,
          '-set_serial',
          '1',
          '-out',
          leafCertificate,
          '-days',
          '1',
          '-extfile',
          extensions,
        ],
        { timeout: 10_000 },
      );
      server = createSecureServer(
        { key: await readFile(leafKey), cert: await readFile(leafCertificate) },
        handleRequest,
      );
      fixtureToken = [
        Buffer.from('{"alg":"none"}').toString('base64url'),
        Buffer.from(
          JSON.stringify({
            exp: Math.floor(Date.now() / 1000) + 86_400,
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'synthetic-account',
              chatgpt_user_id: 'synthetic-user',
              chatgpt_plan_type: 'plus',
            },
          }),
        ).toString('base64url'),
        'synthetic-signature',
      ].join('.');
      await writeFile(
        join(auth, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: fixtureToken,
            access_token: fixtureToken,
            refresh_token: 'SYNTHETIC_REFRESH',
            account_id: 'synthetic-account',
          },
          last_refresh: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      nativeExecutable = join(root, 'synthetic-routing-codex');
    }
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    backendOrigin = `${workspaceRouting ? 'https' : 'http'}://127.0.0.1:${port}`;
    if (workspaceRouting) {
      await writeFile(
        nativeExecutable,
        `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const result=spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,CODEX_CA_CERTIFICATE:${JSON.stringify(fixtureCertificate)},CODEX_REFRESH_TOKEN_URL_OVERRIDE:${JSON.stringify(`${backendOrigin}/oauth/token`)}},timeout:70000});
process.exit(result.status??1);
`,
      );
      await chmod(nativeExecutable, 0o755);
    }
    await writeFile(
      join(auth, 'config.toml'),
      `${workspaceRouting ? `chatgpt_base_url="${backendOrigin}/backend-api"\n` : ''}model_provider="probe"
[model_providers.probe]
name="${workspaceRouting ? 'OpenAI' : 'Anonymous local adapter fixture'}"
base_url="${backendOrigin}${workspaceRouting ? '/backend-api/codex' : '/v1'}"
requires_openai_auth=${workspaceRouting}
wire_api="responses"
request_max_retries=0
stream_max_retries=0
supports_websockets=false
`,
    );
    const git = async (args) => exec('git', ['-C', seed, ...args], { timeout: 10_000 });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Probe']);
    await git(['config', 'user.email', 'probe@example.invalid']);
    await writeFile(join(seed, 'source.cjs'), 'exports.value=1;\n');
    await git(['add', '.']);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
    await git(['remote', 'add', 'origin', seed]);
    await git(['fetch', 'origin']);
    await writeFile(join(seed, 'source.cjs'), 'exports.value=2;\n');
    await git(['-c', 'commit.gpgsign=false', 'commit', '-am', 'change']);
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (stagedInventory) {
      const { CloneManager } = await import(
        join(sandyRoot, 'packages/bot-worker/dist/git/clone-manager.js')
      );
      clones = new CloneManager({ baseDir: join(root, 'clones'), cloneUrl: () => seed });
      const seedWorktree = {
        path: seed,
        repo: { owner: 'evaluation', name: 'producer', defaultBranch: 'main' },
        reviewJobId: 'native-probe',
        sha,
      };
      workspaces = await Promise.all(
        keys.map((key) => clones.reserveAgentWorkspace(seedWorktree, key)),
      );
      paths = workspaces.map((workspace) => workspace.path);
      await Promise.all(
        workspaces
          .slice(0, 2)
          .map((workspace) => clones.populateAgentWorkspace(seedWorktree, workspace)),
      );
    } else {
      paths = await Promise.all(
        keys.map(async (key) => {
          const path = join(root, 'agents', key);
          await cp(seed, path, { recursive: true });
          return path;
        }),
      );
    }
    const writeProbe = async (index) => {
      if (!workspaceRouting) return;
      const path = paths[index];
      await writeFile(
        join(path, 'routing-tool-probe.cjs'),
        `const assert=require('node:assert/strict');
const fs=require('node:fs');
const {join}=require('node:path');
for(const path of [process.cwd(),process.env.HOME,process.env.TMPDIR]) fs.writeFileSync(join(path,'own-artifact.txt'),'fixture');
assert.equal(fs.readFileSync(${JSON.stringify(join(seed, 'source.cjs'))},'utf8'),'exports.value=2;\\n');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(seed, 'source.cjs'))},'BAD'));
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(auth, 'auth.json'))}));
assert.throws(()=>fs.readdirSync(${JSON.stringify(paths[(index + 1) % paths.length])}));
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(paths[(index + 1) % paths.length], 'source.cjs'))}));
assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(paths[(index + 1) % paths.length], 'source.cjs'))},'BAD'));
console.log('ROUTING_SANDBOX_OK:${keys[index]}');
`,
      );
    };
    await Promise.all(
      paths.slice(0, stagedInventory ? 2 : paths.length).map((_, index) => writeProbe(index)),
    );
    const runner = new CodexAppServerRunner({
      codexHome: auth,
      executable: nativeExecutable,
      enableManagedRuntime: true,
      logger: { info() {} },
    });
    runtime = await runner.openReview({
      worktreePath: seed,
      privateWorkspacePaths: paths,
      maxConcurrency: stagedInventory ? 2 : 3,
      signal: AbortSignal.timeout(30_000),
    });
    stopped = false;
    assert.equal(
      runtime.mode,
      'parallel',
      'Native public adapter must pass its managed compatibility gate',
    );
    const run = (index) =>
      runtime.runAgent({
        worktreePath: paths[index],
        agent: {
          key: keys[index],
          name: keys[index],
          vendor: 'codex',
          model: 'mock-model',
          effort: 'high',
          completionSignal: '</findings>',
          systemPrompt: `NATIVE_PROBE_${keys[index]}`,
          tools: [],
        },
        pullRequest: {
          owner: 'evaluation',
          repo: 'producer',
          number: 1,
          headSha: sha,
          baseRef: 'main',
          title: 'Anonymous native fixture',
          url: 'https://example.invalid/fixture',
        },
      });
    const outcomes = stagedInventory
      ? await Promise.allSettled([run(0), run(1)])
      : await Promise.allSettled(paths.map((_, index) => run(index)));
    if (stagedInventory) {
      await Promise.all(
        workspaces.slice(0, 2).map((workspace) => clones.releaseAgentWorkspace(workspace)),
      );
      const seedWorktree = {
        path: seed,
        repo: { owner: 'evaluation', name: 'producer', defaultBranch: 'main' },
        reviewJobId: 'native-probe',
        sha,
      };
      await clones.populateAgentWorkspace(seedWorktree, workspaces[2]);
      await writeProbe(2);
      outcomes.push(...(await Promise.allSettled([run(2)])));
    }
    if (providerFailure) throw providerFailure;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'fulfilled')
        throw new AgentRunError(
          'Native managed adapter did not complete its local fixture',
          undefined,
          agentRunFailure(outcome.reason),
        );
      assert.equal(outcome.value.stdout, `<findings>${keys[index]}</findings>`);
      if (workspaceRouting) assert.equal(outcome.value.activity?.toolCount, 1);
      assert.deepEqual(outcome.value.usage, {
        inputTokens: 90 * (index + 1),
        cacheReadInputTokens: 10 * (index + 1),
        cacheCreationInputTokens: 0,
        outputTokens: 15 * (index + 1),
      });
    }
    assert.equal(pending.length, 3, 'All native requests must complete');
    if (workspaceRouting) assert.ok(routingRequests > 0, 'Native workspace discovery required');
    return {
      platform: process.platform,
      node: process.version,
      codexVersion: version,
      provider: workspaceRouting ? 'synthetic-loopback-chatgpt' : 'anonymous-loopback-fixture',
      ...(workspaceRouting ? { routingRequests, retainedSandboxVerified: true } : {}),
      concurrentAgents: stagedInventory ? 2 : 3,
      ...(stagedInventory ? { stagedInventory: true, retiredPeerRootsVerified: true } : {}),
      completedAgents: 3,
      authoritativeUsage: true,
    };
  } finally {
    try {
      await runtime?.close();
      stopped = true;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (stopped) await rm(root, { recursive: true, force: true });
    }
  }
}

/** Synthetic OAuth authority only; the wrapper override never enters the production env allowlist. */
export async function runNativeAuthRefreshProbe(executable = 'codex') {
  const { CodexAppServerRunner } = await import(
    join(sandyRoot, 'packages/bot-worker/dist/worker/codex-app-server-runner.js')
  );
  const { observeDedicatedAuthRefresh } = await import(
    join(sandyRoot, 'packages/bot-worker/dist/benchmark/auth-refresh-evidence.js')
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-native-auth-probe-')));
  const home = join(root, 'auth');
  const path = join(home, 'auth.json');
  const jwt = (version) =>
    [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 86_400,
          jti: `synthetic-${version}`,
          email: 'fixture@example.invalid',
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'synthetic-account',
            chatgpt_user_id: 'synthetic-user',
            chatgpt_plan_type: 'plus',
          },
        }),
      ).toString('base64url'),
      'synthetic-signature',
    ].join('.');
  const initial = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt('id-1'),
      access_token: jwt('access-1'),
      refresh_token: 'SYNTHETIC_REFRESH_1',
      account_id: 'synthetic-account',
    },
    last_refresh: '2000-01-01T00:00:00Z',
  };
  let requests = 0;
  let runtime;
  let stopped = true;
  let providerFailure;
  const authority = createServer(async (request, response) => {
    try {
      if (request.url !== '/oauth/token') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 65_536, 'Synthetic authority request exceeded bound');
      }
      assert.ok(body.includes('SYNTHETIC_REFRESH_1'), 'Expected only synthetic refresh input');
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          access_token: jwt('access-2'),
          id_token: jwt('id-2'),
          refresh_token: 'SYNTHETIC_REFRESH_2',
          expires_in: 86_400,
          token_type: 'Bearer',
        }),
      );
    } catch (error) {
      providerFailure = error;
      response.destroy();
    }
  });
  try {
    await mkdir(home);
    await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
    await new Promise((resolve) => authority.listen(0, '127.0.0.1', resolve));
    const port = authority.address().port;
    await writeFile(
      join(home, 'config.toml'),
      `model_provider="fixture"
[model_providers.fixture]
name="Synthetic local auth experiment"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
`,
    );
    const wrapper = join(root, 'synthetic-codex');
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const result=spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,CODEX_REFRESH_TOKEN_URL_OVERRIDE:${JSON.stringify(`http://127.0.0.1:${port}/oauth/token`)}},timeout:70000});
process.exit(result.status??1);
`,
    );
    await chmod(wrapper, 0o755);
    const evidence = await observeDedicatedAuthRefresh(home);
    runtime = await new CodexAppServerRunner({
      codexHome: home,
      executable: wrapper,
      enableManagedRuntime: true,
      logger: { info() {} },
    }).openReview({ worktreePath: root, maxConcurrency: 2 });
    stopped = false;
    assert.equal(runtime.mode, 'parallel', 'Native auth probe requires the managed adapter');
    assert.equal(requests, 0, 'Old last_refresh alone must not force native OAuth');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), initial);
    assert.ok(runtime.refreshAuthentication, 'Native public refresh operation required');
    await runtime.refreshAuthentication();
    if (providerFailure) throw providerFailure;
    assert.equal(requests, 1, 'Explicit native refresh must rotate once');
    assert.equal(await evidence.refreshObserved(), true, 'Same-account rotation must persist');
    return {
      provider: 'synthetic-loopback-oauth',
      refreshRequests: requests,
      sameAccountRotation: true,
    };
  } finally {
    try {
      await runtime?.close();
      stopped = true;
    } finally {
      authority.closeAllConnections();
      await new Promise((resolve) => authority.close(resolve));
      if (stopped) await rm(root, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(
    `${JSON.stringify({ ...(await runManagedRuntimeProbe(process.argv[2] ?? 'codex')), workspaceRouting: await runManagedRuntimeProbe(process.argv[2] ?? 'codex', true), stagedInventory: await runManagedRuntimeProbe(process.argv[2] ?? 'codex', true, true), authentication: await runNativeAuthRefreshProbe(process.argv[2] ?? 'codex') })}\n`,
  );
