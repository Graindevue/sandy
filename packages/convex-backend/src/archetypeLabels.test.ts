import { describe, expect, it } from 'vitest';
import { labelFromFindingSummary } from '../convex/archetypeLabels.js';

describe('labelFromFindingSummary', () => {
  it('generates a short human-readable Archetype label from a Finding summary', () => {
    expect(
      labelFromFindingSummary(
        'The cache key ignores the tenant id, allowing records from separate tenants to collide.',
      ),
    ).toBe('The cache key ignores the tenant id allowing');
  });

  it('uses a fallback label for empty summaries', () => {
    expect(labelFromFindingSummary('   ')).toBe('Unlabeled finding');
  });
});
