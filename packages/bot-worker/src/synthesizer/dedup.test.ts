import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { dedupeFindings } from './dedup.js';

interface FindingInput {
  agentKey: string;
  lines: [number, number];
  summary: string;
  identifiers: string[];
  path?: string;
  severity?: Finding['severity'];
}

function finding({
  agentKey,
  lines,
  summary,
  identifiers,
  path = 'src/webhooks/deliver.ts',
  severity = 'P2',
}: FindingInput): Finding {
  return {
    severity,
    confidence: 4,
    agentKey,
    anchor: { repo: 'acme/widget', path, lineStart: lines[0], lineEnd: lines[1] },
    summary,
    evidence: `See ${identifiers.join(' and ')}.`,
    category: agentKey,
  };
}

// Summaries are worded differently so only the cross-agent rule can merge them.
const RETRY_SUMMARY = 'Retries can send the same payload twice.';
const RESTART_SUMMARY = 'A worker restart repeats an earlier attempt.';

describe('dedupeFindings across Agents', () => {
  it('merges overlapping findings that share identifiers and credits the other Agent', () => {
    const merged = dedupeFindings([
      finding({
        agentKey: 'security',
        lines: [10, 14],
        summary: RETRY_SUMMARY,
        identifiers: ['retryDelivery', 'deliveryId'],
      }),
      finding({
        agentKey: 'logic',
        lines: [11, 14],
        summary: RESTART_SUMMARY,
        identifiers: ['retryDelivery', 'deliveryId', 'sendWebhook'],
        severity: 'P1',
      }),
    ]);

    expect(merged).toEqual([
      expect.objectContaining({ agentKey: 'logic', severity: 'P1', alsoReportedBy: ['security'] }),
    ]);
  });

  it('merges at exactly a quarter of shared identifiers', () => {
    const merged = dedupeFindings([
      finding({
        agentKey: 'logic',
        lines: [20, 24],
        summary: RETRY_SUMMARY,
        identifiers: ['sharedKey', 'leftOne', 'leftTwo', 'leftThree'],
      }),
      finding({
        agentKey: 'security',
        lines: [20, 24],
        summary: RESTART_SUMMARY,
        identifiers: ['sharedKey', 'rightOne', 'rightTwo', 'rightThree', 'rightFour'],
      }),
    ]);

    expect(merged).toHaveLength(1);
  });

  it('keeps findings on the same lines separate when they share under a quarter of identifiers', () => {
    const findings = [
      finding({
        agentKey: 'logic',
        lines: [20, 24],
        summary: RETRY_SUMMARY,
        identifiers: ['sharedKey', 'leftOne', 'leftTwo', 'leftThree', 'leftFour'],
      }),
      finding({
        agentKey: 'security',
        lines: [20, 24],
        summary: RESTART_SUMMARY,
        identifiers: ['sharedKey', 'rightOne', 'rightTwo', 'rightThree', 'rightFour', 'rightFive'],
      }),
    ];

    const kept = dedupeFindings(findings);

    expect(kept).toHaveLength(2);
    for (const { alsoReportedBy } of kept) {
      expect(alsoReportedBy).toBeUndefined();
    }
  });

  it('keeps findings separate when only half of the shorter anchor overlaps', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 13], summary: RETRY_SUMMARY, identifiers }),
        finding({ agentKey: 'security', lines: [12, 19], summary: RESTART_SUMMARY, identifiers }),
      ]),
    ).toHaveLength(2);
  });

  it('merges once more than half of the shorter anchor overlaps', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 12], summary: RETRY_SUMMARY, identifiers }),
        finding({ agentKey: 'security', lines: [11, 20], summary: RESTART_SUMMARY, identifiers }),
      ]),
    ).toHaveLength(1);
  });

  it('keeps findings separate when their anchors do not overlap', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 12], summary: RETRY_SUMMARY, identifiers }),
        finding({ agentKey: 'security', lines: [30, 32], summary: RESTART_SUMMARY, identifiers }),
      ]),
    ).toHaveLength(2);
  });

  it('keeps findings in different files separate', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 14], summary: RETRY_SUMMARY, identifiers }),
        finding({
          agentKey: 'security',
          lines: [10, 14],
          summary: RESTART_SUMMARY,
          identifiers,
          path: 'src/webhooks/queue.ts',
        }),
      ]),
    ).toHaveLength(2);
  });

  it('credits every merged Agent once when three Agents report the same defect', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 14], summary: RETRY_SUMMARY, identifiers }),
        finding({
          agentKey: 'security',
          lines: [10, 14],
          summary: RESTART_SUMMARY,
          identifiers,
          severity: 'P1',
        }),
        finding({
          agentKey: 'test-coverage',
          lines: [11, 13],
          summary: 'Nothing covers a second attempt.',
          identifiers,
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        agentKey: 'security',
        alsoReportedBy: ['logic', 'test-coverage'],
      }),
    ]);
  });

  it('does not chain two unrelated findings together through a third', () => {
    const merged = dedupeFindings([
      finding({
        agentKey: 'logic',
        lines: [10, 14],
        summary: RETRY_SUMMARY,
        identifiers: ['retryDelivery', 'leftOne', 'leftTwo', 'leftThree'],
      }),
      finding({
        agentKey: 'security',
        lines: [10, 14],
        summary: RESTART_SUMMARY,
        identifiers: ['retryDelivery', 'signPayload', 'middleOne', 'middleTwo'],
      }),
      finding({
        agentKey: 'test-coverage',
        lines: [10, 14],
        summary: 'Nothing covers a second attempt.',
        identifiers: ['signPayload', 'rightOne', 'rightTwo', 'rightThree'],
      }),
    ]);

    expect(merged).toHaveLength(2);
  });
});

describe('dedupeFindings within one Agent', () => {
  it('does not apply the cross-agent rule to findings from the same Agent', () => {
    const identifiers = ['retryDelivery', 'deliveryId'];

    expect(
      dedupeFindings([
        finding({ agentKey: 'logic', lines: [10, 14], summary: RETRY_SUMMARY, identifiers }),
        finding({ agentKey: 'logic', lines: [10, 14], summary: RESTART_SUMMARY, identifiers }),
      ]),
    ).toHaveLength(2);
  });

  it('merges near-identical summaries on nearby lines without crediting anyone', () => {
    const merged = dedupeFindings([
      finding({
        agentKey: 'logic',
        lines: [10, 10],
        summary: RETRY_SUMMARY,
        identifiers: ['retryDelivery'],
      }),
      finding({
        agentKey: 'logic',
        lines: [12, 12],
        summary: RETRY_SUMMARY,
        identifiers: ['sendWebhook'],
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.alsoReportedBy).toBeUndefined();
  });
});
