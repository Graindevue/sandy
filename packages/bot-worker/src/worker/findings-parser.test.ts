import { describe, expect, it } from 'vitest';
import { parseFindingsPayload } from './findings-parser.js';

describe('parseFindingsPayload', () => {
  it('extracts and validates a FindingsPayload object from the findings tag', () => {
    const payload = parseFindingsPayload(`
      analysis before
      <findings>
      {
        "summary": "One real issue.",
        "findings": [
          {
            "severity": "P1",
            "confidence": 4,
            "agentKey": "logic",
            "anchor": {
              "repo": "acme/widget",
              "path": "src/index.ts",
              "lineStart": 12,
              "lineEnd": 14
            },
            "crossRepoReferences": [
              {
                "repo": "acme/consumer",
                "path": "src/orders.ts",
                "line": 31
              }
            ],
            "summary": "The cache key ignores the tenant id.",
            "evidence": "The lookup only uses userId, so two tenants can collide.",
            "suggestedFix": "Include tenantId in the key.",
            "category": "logic"
          }
        ]
      }
      </findings>
      trailing notes
    `);

    expect(payload.summary).toBe('One real issue.');
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      severity: 'P1',
      confidence: 4,
      agentKey: 'logic',
      anchor: {
        repo: 'acme/widget',
        path: 'src/index.ts',
        lineStart: 12,
        lineEnd: 14,
      },
      crossRepoReferences: [{ repo: 'acme/consumer', path: 'src/orders.ts', line: 31 }],
      category: 'logic',
    });
  });

  it('validates an anchor-only same-Repo finding without cross-repo references', () => {
    const payload = parseFindingsPayload(`<findings>{
      "findings": [{
        "severity": "P2",
        "confidence": 3,
        "agentKey": "test-coverage",
        "anchor": {
          "repo": "acme/widget",
          "path": "src/cache.test.ts",
          "lineStart": 9,
          "lineEnd": 9
        },
        "summary": "The changed cache branch has no regression test.",
        "evidence": "No test covers tenant-specific cache keys.",
        "category": "test-coverage"
      }]
    }</findings>`);

    expect(payload.findings[0]).toEqual({
      severity: 'P2',
      confidence: 3,
      agentKey: 'test-coverage',
      anchor: {
        repo: 'acme/widget',
        path: 'src/cache.test.ts',
        lineStart: 9,
        lineEnd: 9,
      },
      summary: 'The changed cache branch has no regression test.',
      evidence: 'No test covers tenant-specific cache keys.',
      category: 'test-coverage',
    });
  });

  it('rejects malformed output with an actionable error', () => {
    expect(() =>
      parseFindingsPayload(`<findings>{
        "findings": [{
          "severity": "P9",
          "confidence": 4,
          "agentKey": "logic",
          "anchor": {
            "repo": "acme/widget",
            "path": "src/index.ts",
            "lineStart": 12,
            "lineEnd": 14
          },
          "summary": "Bad severity.",
          "evidence": "Bad severity.",
          "category": "logic"
        }]
      }</findings>`),
    ).toThrow(/severity/i);
  });

  it('uses the final findings block when earlier narration contains an example', () => {
    const payload = parseFindingsPayload(`
      Example:
      <findings>{"summary":"Example only.","findings":[]}</findings>

      Final answer:
      <findings>{"summary":"Real result.","findings":[]}</findings>
    `);

    expect(payload).toEqual({ summary: 'Real result.', findings: [] });
  });

  it('rejects output with no findings tag', () => {
    expect(() => parseFindingsPayload('no structured output')).toThrow(/<findings>/);
  });
});
