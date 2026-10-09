import type { UserIdentity } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRepo } from '../convex/pullRequests.js';
import { serviceIdentity, stubReviewServiceConfig } from './serviceAuthTestUtils.js';

type RegisteredFunction = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isHttp?: boolean;
  exportArgs(): string;
  exportReturns(): string;
  _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown>;
};

const modules = import.meta.glob(
  ['../convex/**/*.ts', '!../convex/_generated/**', '!../convex/**/*.d.ts'],
  { eager: true },
);
const publicFunctions = Object.entries(modules).flatMap(([path, module]) =>
  Object.entries(module as Record<string, unknown>)
    .filter(([, value]) => (value as RegisteredFunction | null)?.isPublic === true)
    .map(([name, value]) => ({ name: `${path}:${name}`, fn: value as RegisteredFunction })),
);

beforeEach(stubReviewServiceConfig);
afterEach(() => vi.unstubAllEnvs());

function context(identity: UserIdentity | null) {
  const touched = vi.fn(() => {
    throw new Error('Private state was accessed before authorization');
  });
  return {
    auth: { getUserIdentity: vi.fn(async () => identity) },
    db: new Proxy({}, { get: touched }),
    runQuery: touched,
    runMutation: touched,
    runAction: touched,
    vectorSearch: touched,
    touched,
  };
}

describe('Convex service authorization', () => {
  it('covers the complete public query, mutation, and action surface', () => {
    expect(publicFunctions).toHaveLength(38);
    for (const kind of ['isQuery', 'isMutation', 'isAction'] as const) {
      expect(publicFunctions.some(({ fn }) => fn[kind])).toBe(true);
    }
  });

  it('requires explicit argument and return validators on the public surface', () => {
    for (const { fn } of publicFunctions) {
      expect(JSON.parse(fn.exportArgs())).not.toBeNull();
      expect(JSON.parse(fn.exportReturns())).not.toBeNull();
    }
  });

  it('requires a security review before adding an HTTP surface outside the service guard', () => {
    for (const module of Object.values(modules)) {
      for (const value of Object.values(module as Record<string, unknown>)) {
        expect((value as RegisteredFunction | null)?.isHttp).not.toBe(true);
        const router = value as { getRoutes?: () => unknown[] } | null;
        if (typeof router?.getRoutes === 'function') expect(router.getRoutes()).toEqual([]);
      }
    }
  });

  it.each(publicFunctions)(
    'rejects anonymous calls to $name before private state',
    async ({ fn }) => {
      const ctx = context(null);
      await expect(fn._handler(ctx, {})).rejects.toThrow('Unauthorized');
      expect(ctx.auth.getUserIdentity).toHaveBeenCalledOnce();
      expect(ctx.touched).not.toHaveBeenCalled();
    },
  );

  it.each([
    { issuer: 'https://attacker.example' },
    { repository_id: '456' },
    { repository_id: 123 },
    { workflow_ref: 'acme/widget/.github/workflows/other.yml@refs/heads/main' },
    { workflow_ref: 'acme/widget/.github/workflows/sandy-review.yml@refs/heads/feature' },
    { environment: 'other' },
    { environment: null },
    { repository_visibility: 'public' },
    { event_name: 'pull_request' },
    { event_name: 'workflow_dispatch' },
    { run_attempt: '2' },
    { run_attempt: 1 },
  ])(
    'rejects a verified token with the wrong trust claim %j across all functions',
    async (claims) => {
      for (const { fn } of publicFunctions) {
        const ctx = context({ ...serviceIdentity, ...claims });
        await expect(fn._handler(ctx, {})).rejects.toThrow('Unauthorized');
        expect(ctx.touched).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['SANDY_AUTH_REPOSITORY_ID', 'SANDY_AUTH_WORKFLOW_REF', 'SANDY_AUTH_ENVIRONMENT'])(
    'fails closed without deployment configuration %s',
    async (key) => {
      vi.stubEnv(key, '');
      for (const { fn } of publicFunctions) {
        const ctx = context(serviceIdentity);
        await expect(fn._handler(ctx, {})).rejects.toThrow('Unauthorized');
        expect(ctx.touched).not.toHaveBeenCalled();
      }
    },
  );

  it('lets the trusted service reach the existing Repo bootstrap transaction', async () => {
    const unique = vi.fn(async () => ({ _id: 'repo-id' }));
    const withIndex = vi.fn(() => ({ unique }));
    const query = vi.fn(() => ({ withIndex }));
    await expect(
      ensureRepo._handler(
        {
          auth: { getUserIdentity: async () => serviceIdentity },
          db: { query },
        },
        { owner: 'acme', name: 'widget' },
      ),
    ).resolves.toBe('repo-id');
    expect(query).toHaveBeenCalledWith('repos');
  });
});
