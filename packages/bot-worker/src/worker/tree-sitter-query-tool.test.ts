import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const toolPath = join(repoRoot, 'images', 'agent', 'tree_sitter_query.mjs');

describe('tree_sitter_query agent tool', () => {
  it('returns structural captures for TypeScript files as JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandy-tree-sitter-query-'));
    try {
      const file = join(dir, 'orders.ts');
      await writeFile(file, 'const orders = getActiveOrders(userId);\n', 'utf8');

      const { stdout } = await execFileAsync(process.execPath, [
        toolPath,
        '--json',
        file,
        '(call_expression function: (identifier) @callee)',
      ]);

      const result = JSON.parse(stdout) as {
        matches: Array<{
          captures: Array<{ name: string; text: string; start: { line: number; column: number } }>;
        }>;
      };

      expect(result.matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            captures: expect.arrayContaining([
              expect.objectContaining({
                name: 'callee',
                text: 'getActiveOrders',
                start: { line: 1, column: 15 },
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('infers JavaScript grammar for .js files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandy-tree-sitter-query-'));
    try {
      const file = join(dir, 'orders.js');
      await writeFile(file, 'const orders = getActiveOrders(userId);\n', 'utf8');

      const { stdout } = await execFileAsync(process.execPath, [
        toolPath,
        '--json',
        file,
        '(call_expression function: (identifier) @callee)',
      ]);

      expect(JSON.parse(stdout)).toMatchObject({
        language: 'javascript',
        matches: [
          {
            captures: [
              {
                name: 'callee',
                text: 'getActiveOrders',
              },
            ],
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
