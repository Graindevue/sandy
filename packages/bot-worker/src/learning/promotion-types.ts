import type { PullRequestState } from '@sandy/shared-types';

export interface PendingSuppressionPromotion {
  _id: string;
}

export interface PromotionRepo {
  _id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface PromotionExemplar {
  findingId?: string;
  summary: string;
  evidence: string;
  category?: string;
  anchor: {
    repo: string;
    path: string;
    lineStart: number;
    lineEnd: number;
  };
}

export interface PendingPositivePromotion {
  _id: string;
  description: string;
  archetypeLabel: string;
  targetRepo: PromotionRepo;
  exemplars: PromotionExemplar[];
}

export interface PromotionWorkerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ProductRulesPullRequest {
  number: number;
  draft: boolean;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  url: string;
  state: PullRequestState;
}

export interface ProductRulesPullRequestInput {
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  suggestedRuleId: string;
  ruleLine: string;
}

export interface ProductRuleGitHub {
  openProductRulesPullRequest(
    input: ProductRulesPullRequestInput,
  ): Promise<ProductRulesPullRequest>;
}

export interface PositivePromotionRecord {
  suggestedRuleId: string;
  repoId: string;
  pullRequest: ProductRulesPullRequest;
  agentKeys: string[];
}

export interface PositivePromotionRecordResult {
  promoted: boolean;
  pullRequestId: string;
  reviewJobId: string;
}

export interface PositivePromotionStore {
  recordPositivePromotion(input: PositivePromotionRecord): Promise<PositivePromotionRecordResult>;
}
