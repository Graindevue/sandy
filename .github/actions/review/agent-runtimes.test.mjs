import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatedAgentRuntimes } from './agent-runtimes.mjs';

test('generated configuration opts only the selected reviewers into Fast mode', () => {
  const defaults = generatedAgentRuntimes('gpt-6.1-sol');
  assert.ok(Object.values(defaults).every((runtime) => runtime.fastMode === undefined));
  const selected = generatedAgentRuntimes('gpt-6.1-sol', ' logic, convex ');
  assert.deepEqual(selected.logic, {
    vendor: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    fastMode: true,
  });
  assert.equal(selected.convex.fastMode, true);
  assert.deepEqual(selected.security, defaults.security);
  assert.throws(() => generatedAgentRuntimes('gpt-6.1-sol', 'logci'), /Unknown fast-mode Agent/);
});
