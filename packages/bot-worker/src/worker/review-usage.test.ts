import { describe, expect, it } from 'vitest';
import { buildReviewUsageSummary } from './review-usage.js';

const usage = {
  inputTokens: 100_000,
  cacheCreationInputTokens: 20_000,
  cacheReadInputTokens: 800_000,
  outputTokens: 10_000,
};

describe('review usage summary', () => {
  it('prices cached reads separately and cache writes as regular input, with the Fast multiplier', () => {
    const summary = buildReviewUsageSummary([
      { agent: { key: 'logic', model: 'gpt-6.1-sol', fastMode: true }, usage },
      { agent: { key: 'security', model: 'gpt-6-luna' }, usage },
    ]);
    expect(summary).toContain(
      '| logic | gpt-6.1-sol | Fast | 120,000 | 800,000 | 10,000 | 21.00 |',
    );
    expect(summary).toContain(
      '| security | gpt-6-luna | Standard | 120,000 | 800,000 | 10,000 | 0.625 |',
    );
    expect(summary).toContain('**21.625 credits**');
    expect(summary).toContain('not a subscription charge or quota measurement');
    expect(summary).toContain('Excludes the authentication warm-up');
  });

  it('keeps missing usage and unknown prices out of a clearly marked partial subtotal', () => {
    const summary = buildReviewUsageSummary([
      { agent: { key: 'logic', model: 'gpt-6.1-sol' }, usage },
      { agent: { key: 'security', model: 'gpt-6.1-sol' }, usage: undefined },
      { agent: { key: 'other|agent', model: 'future\nmodel' }, usage },
    ]);
    expect(summary).toContain('subtotal (reported, priced Agents only): **10.50 credits**');
    expect(summary).toContain('Usage is incomplete');
    expect(summary).toContain('unknown model rate');
    expect(summary).toContain('other\\|agent | future model');
    expect(summary).not.toContain('NaN');
  });

  it('distinguishes unavailable usage from a reported zero', () => {
    const agent = { key: 'logic', model: 'gpt-6.1-sol' };
    expect(buildReviewUsageSummary([{ agent, usage: undefined }])).toContain(
      'Credit estimate unavailable',
    );
    const zero = {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    };
    expect(buildReviewUsageSummary([{ agent, usage: zero }])).toContain('total: **0.00 credits**');
  });
});
