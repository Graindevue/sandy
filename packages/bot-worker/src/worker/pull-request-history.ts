import type { Finding } from '@sandy/shared-types';
import type { PullRequestTarget } from './poster.js';

/** A human reply in the thread under an earlier Sandy finding comment. */
export interface PriorFindingReply {
  author: string;
  body: string;
}

/** An earlier Sandy finding posted on the same PR, with the author's replies. */
export interface PriorFinding {
  severity: Finding['severity'];
  category: string;
  summary: string;
  path: string;
  /** Current diff line; absent when GitHub marks the comment outdated. */
  line?: number;
  /** The anchored code changed after the finding was posted. */
  outdated: boolean;
  reviewedCommit: string;
  replies: PriorFindingReply[];
}

/** PR context Agents need to avoid re-proposing settled changes. */
export interface PullRequestHistory {
  body: string | null;
  linkedIssues: { number: number; title: string }[];
  priorFindings: PriorFinding[];
}

export interface PullRequestHistorySource {
  loadPullRequestHistory(target: PullRequestTarget): Promise<PullRequestHistory>;
}
