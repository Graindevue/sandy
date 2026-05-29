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
            "location": {
              "repo": "acme/widget",
              "path": "src/index.ts",
              "lineStart": 12,
              "lineEnd": 14
            },
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
      location: {
        repo: 'acme/widget',
        path: 'src/index.ts',
        lineStart: 12,
        lineEnd: 14,
      },
      category: 'logic',
    });
  });

  it('rejects malformed output with an actionable error', () => {
    expect(() =>
      parseFindingsPayload(`<findings>{
        "findings": [{
          "severity": "P9",
          "confidence": 4,
          "location": {
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

  it('rejects output with no findings tag', () => {
    expect(() => parseFindingsPayload('no structured output')).toThrow(/<findings>/);
  });
});
