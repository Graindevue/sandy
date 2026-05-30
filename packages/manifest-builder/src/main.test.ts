import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import npmExports from './extractors/npm-exports.js';
import { buildManifest } from './main.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'sandy-manifest-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('buildManifest', () => {
  it('builds markdown and structured sections from every supplied Repo worktree', async () => {
    const api = await makeRepo('api');
    await write(api, 'package.json', JSON.stringify(packageJson('@acme/api'), null, 2));
    await write(
      api,
      'pnpm-lock.yaml',
      [
        'lockfileVersion: "9.0"',
        'packages:',
        '  next@16.0.1:',
        '    resolution: {integrity: sha512-next}',
        '  convex@1.39.0:',
        '    resolution: {integrity: sha512-convex}',
        '',
      ].join('\n'),
    );
    await write(
      api,
      'src/index.ts',
      [
        'export interface User { id: string; name: string }',
        'export function getUser(id: string): Promise<User> {',
        '  return Promise.resolve({ id, name: "Ada" });',
        '}',
      ].join('\n'),
    );
    await write(
      api,
      'convex/users.ts',
      [
        'import { query, mutation } from "./_generated/server";',
        'import { v } from "convex/values";',
        'export const getUser = query({',
        '  args: { id: v.id("users") },',
        '  handler: async (ctx, args) => ctx.db.get(args.id),',
        '});',
        'export const renameUser = mutation({',
        '  args: { id: v.id("users"), name: v.string() },',
        '  handler: async () => null,',
        '});',
      ].join('\n'),
    );
    await write(
      api,
      'convex/schema.ts',
      [
        'import { defineSchema, defineTable } from "convex/server";',
        'import { v } from "convex/values";',
        'export default defineSchema({',
        '  users: defineTable({',
        '    name: v.string(),',
        '    email: v.optional(v.string()),',
        '  }).index("by_email", ["email"]),',
        '});',
      ].join('\n'),
    );
    await write(
      api,
      'app/api/users/[id]/route.ts',
      [
        'export async function GET() {',
        '  return Response.json({ ok: true });',
        '}',
        'export async function POST() {',
        '  return Response.json({ ok: true });',
        '}',
      ].join('\n'),
    );
    await write(
      api,
      'messages/en.json',
      JSON.stringify({ dashboard: { title: 'Dashboard' }, actions: { save: 'Save' } }, null, 2),
    );

    const web = await makeRepo('web');
    await write(web, 'package.json', JSON.stringify({ name: '@acme/web', dependencies: {} }));
    await write(web, 'src/index.ts', 'export const appName = "web";\n');

    const result = await buildManifest(
      'product-1',
      [repoInput('acme/api', api, '1111111'), repoInput('acme/web', web, '2222222')],
      { now: () => 1_800_000_000_000 },
    );

    expect(result.structured.productId).toBe('product-1');
    expect(result.structured.repoShas).toEqual([
      { repo: 'acme/api', sha: '1111111' },
      { repo: 'acme/web', sha: '2222222' },
    ]);
    expect(result.structured.repos.map((repo) => repo.repo)).toEqual(['acme/api', 'acme/web']);
    for (const repo of result.structured.repos) {
      expect(repo.sections.map((section) => section.key)).toEqual([
        'framework-versions',
        'npm-exports',
        'convex-api',
        'convex-schema',
        'http-routes',
        'i18n-keys',
      ]);
    }

    expect(result.markdown).toContain('# API Surface Manifest');
    expect(result.markdown).toContain('Product: `product-1`');
    expect(result.markdown).toContain('`acme/api` @ `1111111`');
    expect(result.markdown).toContain('`acme/web` @ `2222222`');
    expect(result.markdown).toContain('### Framework Versions');
    expect(result.markdown).toContain('next');
    expect(result.markdown).toContain('16.0.1');
    expect(result.markdown).toContain('### npm Exports');
    expect(result.markdown).toContain('getUser');
    expect(result.markdown).toContain('### Convex API');
    expect(result.markdown).toContain('query');
    expect(result.markdown).toContain('renameUser');
    expect(result.markdown).toContain('### Convex Schema');
    expect(result.markdown).toContain('users');
    expect(result.markdown).toContain('by_email');
    expect(result.markdown).toContain('### HTTP Routes');
    expect(result.markdown).toContain('GET /api/users/:id');
    expect(result.markdown).toContain('POST /api/users/:id');
    expect(result.markdown).toContain('### i18n Keys');
    expect(result.markdown).toContain('dashboard.title');
    expect(result.markdown).toContain('actions.save');
  });

  it('overlays a custom extractor from .config/extractors over a default extractor key', async () => {
    const repo = await makeRepo('api');
    await write(repo, 'package.json', JSON.stringify(packageJson('@acme/api'), null, 2));
    const customDir = join(tmpRoot, '.config', 'extractors');
    await mkdir(customDir, { recursive: true });
    await writeFile(
      join(customDir, 'framework-versions.ts'),
      [
        'export default {',
        '  key: "framework-versions",',
        '  title: "Custom Framework Surface",',
        '  async extract() {',
        '    return { markdown: "Custom extractor output.", data: { custom: true } };',
        '  },',
        '};',
      ].join('\n'),
    );

    const result = await buildManifest('product-1', [repoInput('acme/api', repo, 'abc123')], {
      customExtractorsDir: customDir,
      now: () => 1_800_000_000_000,
    });

    const section = result.structured.repos[0]?.sections[0];
    expect(section).toMatchObject({
      key: 'framework-versions',
      title: 'Custom Framework Surface',
      data: { custom: true },
    });
    expect(result.markdown).toContain('### Custom Framework Surface');
    expect(result.markdown).toContain('Custom extractor output.');
    expect(result.markdown).not.toContain('Declared');
  });

  it('does not follow package entrypoints outside a Repo worktree', async () => {
    const repo = await makeRepo('api');
    const secretPath = join(tmpRoot, 'secret.ts');
    await writeFile(secretPath, 'export const leakedSecret = "do-not-read";\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await symlink(secretPath, join(repo, 'src', 'index.ts'));
    await write(
      repo,
      'package.json',
      JSON.stringify({
        name: '@acme/api',
        exports: {
          './escape': '../secret.ts',
          './link': './src/index.ts',
        },
      }),
    );

    const result = await buildManifest('product-1', [repoInput('acme/api', repo, 'abc123')], {
      extractors: [npmExports],
      now: () => 1_800_000_000_000,
    });

    expect(result.structured.repos[0]?.sections[0]?.data).toEqual([]);
    expect(result.markdown).not.toContain('leakedSecret');
    expect(result.markdown).not.toContain('do-not-read');
  });

  it('resolves package entrypoint directories to index files', async () => {
    const repo = await makeRepo('api');
    await write(
      repo,
      'package.json',
      JSON.stringify({
        name: '@acme/api',
        exports: './src',
      }),
    );
    await write(repo, 'src/index.ts', 'export const publicName = "api";\n');

    const result = await buildManifest('product-1', [repoInput('acme/api', repo, 'abc123')], {
      extractors: [npmExports],
      now: () => 1_800_000_000_000,
    });

    expect(result.markdown).toContain('`.` -> `src/index.ts`');
    expect(result.markdown).toContain('publicName');
  });
});

async function makeRepo(name: string): Promise<string> {
  const repo = join(tmpRoot, name);
  await mkdir(repo, { recursive: true });
  return repo;
}

function packageJson(name: string): unknown {
  return {
    name,
    version: '1.0.0',
    exports: {
      '.': './src/index.ts',
    },
    dependencies: {
      convex: '^1.39.0',
      next: '^16.0.0',
    },
  };
}

function repoInput(fullName: string, worktreePath: string, sha: string) {
  const [owner, name] = fullName.split('/');
  return {
    owner: owner ?? '',
    name: name ?? '',
    fullName,
    defaultBranch: 'main',
    worktreePath,
    sha,
  };
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, contents);
}
