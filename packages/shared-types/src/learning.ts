import type { FindingId } from './finding.js';
import type { ProductId } from './product.js';

/** Stable identifier for an Archetype (a Convex document id at runtime). */
export type ArchetypeId = string;

/** Stable identifier for a Reaction (a Convex document id at runtime). */
export type ReactionId = string;

/** Stable identifier for a SuggestedRule (a Convex document id at runtime). */
export type SuggestedRuleId = string;

export const REACTION_KINDS = ['👍', '👎', 'reply', 'mergedFixed', 'mergedIgnored'] as const;

/** Feedback signal attached to a posted Finding. */
export type ReactionKind = (typeof REACTION_KINDS)[number];

export const SUGGESTED_RULE_TYPES = ['positive', 'suppression'] as const;

/** The kind of Rule a SuggestedRule can promote into. */
export type SuggestedRuleType = (typeof SUGGESTED_RULE_TYPES)[number];

export const SUGGESTED_RULE_STATUSES = [
  'suggested',
  'promoteToPositive',
  'promoteToSuppression',
  'rejected',
  'promoted',
] as const;

/** Manual operator workflow state for a SuggestedRule. */
export type SuggestedRuleStatus = (typeof SUGGESTED_RULE_STATUSES)[number];

/** A cluster of semantically similar Findings. */
export interface Archetype {
  id: ArchetypeId;
  productId: ProductId;
  agentKey: string;
  label: string;
  exemplarEmbedding: number[];
  exampleFindingIds: FindingId[];
  count: number;
  suppressionWeight: number;
  createdAt: number;
}

/** A feedback signal attached to a posted Finding. */
export interface Reaction {
  id: ReactionId;
  findingId: FindingId;
  kind: ReactionKind;
  replyText?: string;
  createdAt: number;
}

/** A candidate Rule inferred by the learning loop and awaiting manual action. */
export interface SuggestedRule {
  id: SuggestedRuleId;
  productId: ProductId;
  type: SuggestedRuleType;
  status: SuggestedRuleStatus;
  description: string;
  sourceArchetypeId: ArchetypeId;
  evidence: string;
  createdAt: number;
}
