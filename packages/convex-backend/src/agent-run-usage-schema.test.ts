import { describe, expect, it } from 'vitest';
import schema from '../convex/schema.js';
import { exportSchema, getTable, optional, required } from './schemaExportTestUtils.js';

const exportedSchema = exportSchema(schema);

describe('Agent Run Usage schema', () => {
  it('adds optional token usage to Agent Runs', () => {
    expect(table('agentRuns').documentType.value.usage).toEqual(
      optional({
        type: 'object',
        value: {
          inputTokens: required({ type: 'number' }),
          cacheCreationInputTokens: required({ type: 'number' }),
          cacheReadInputTokens: required({ type: 'number' }),
          outputTokens: required({ type: 'number' }),
        },
      }),
    );
  });
});

function table(name: string) {
  return getTable(exportedSchema, name);
}
