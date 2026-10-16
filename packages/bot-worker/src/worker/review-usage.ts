import type { AgentDefinition, AgentRunUsage } from '@sandy/shared-types';

// Purchased-credit rates per million tokens, verified 2026-10-16:
// https://learn.chatgpt.com/docs/pricing#token-rates
const CREDIT_RATES = new Map<string, readonly [number, number, number]>([
  ['gpt-6.1-sol', [50, 2.5, 250]],
  ['gpt-6-astra', [250, 25, 1250]],
  ['gpt-6-sol', [50, 5, 250]],
  ['gpt-6-luna', [2.5, 0.25, 12.5]],
  ['gpt-5.6-sol', [100, 10, 500]],
  ['gpt-5.6-terra', [50, 5, 300]],
  ['gpt-5.6-luna', [5, 0.5, 30]],
]);

interface AgentUsage {
  agent: Pick<AgentDefinition, 'key' | 'model' | 'fastMode'>;
  usage: AgentRunUsage | undefined;
}

export function buildReviewUsageSummary(entries: readonly AgentUsage[]): string {
  const parts = [
    'Reviewer usage:',
    '',
    '| Agent | Model | Requested speed | Input (uncached) | Cached input | Output | Est. credits |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ];
  let credits = 0;
  let priced = 0;
  for (const { agent, usage } of entries) {
    const rates = CREDIT_RATES.get(agent.model);
    const input =
      usage === undefined ? undefined : usage.inputTokens + usage.cacheCreationInputTokens;
    const estimate =
      usage === undefined || rates === undefined || input === undefined
        ? undefined
        : ((input * rates[0] +
            usage.cacheReadInputTokens * rates[1] +
            usage.outputTokens * rates[2]) /
            1_000_000) *
          (agent.fastMode ? 2 : 1);
    if (estimate !== undefined) {
      credits += estimate;
      priced++;
    }
    parts.push(
      `| ${cell(agent.key)} | ${cell(agent.model)} | ${agent.fastMode ? 'Fast' : 'Standard'} | ${count(input)} | ${count(usage?.cacheReadInputTokens)} | ${count(usage?.outputTokens)} | ${estimate === undefined ? 'unavailable' : formatCredits(estimate)} |`,
    );
  }
  parts.push('');
  if (priced > 0) {
    parts.push(
      `Estimated purchased-credit ${priced === entries.length ? 'total' : 'subtotal (reported, priced Agents only)'}: **${formatCredits(credits)} credits**.`,
    );
  } else {
    parts.push('Credit estimate unavailable: no reported usage with a known model rate.');
  }
  if (entries.some(({ usage }) => usage === undefined)) {
    parts.push('Usage is incomplete: one or more Agents did not report token counts.');
  }
  if (entries.some(({ agent }) => !CREDIT_RATES.has(agent.model))) {
    parts.push('An unknown model rate is excluded from the estimate.');
  }
  parts.push(
    'Based on requested speed and [OpenAI credit rates](https://learn.chatgpt.com/docs/pricing#token-rates), verified 2026-10-16; Fast mode uses 2× purchased credits. This is an estimate, not a subscription charge or quota measurement. Excludes the authentication warm-up and GitHub Actions compute.',
  );
  return parts.join('\n');
}

function count(value: number | undefined): string {
  return value === undefined ? 'unavailable' : value.toLocaleString('en-US');
}

function formatCredits(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/[\r\n]/g, ' ');
}
