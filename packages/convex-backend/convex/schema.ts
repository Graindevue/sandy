import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  agentRunStatus,
  confidence,
  crossRepoReference,
  crossRepoSearchRationale,
  findingAnchor,
  pullRequestState,
  reactionKind,
  reviewJobStatus,
  reviewTrigger,
  severity,
  siblingShas,
  suggestedRuleStatus,
  suggestedRuleType,
} from './validators.js';

/**
 * Sandy's durable queue, review, and learning-loop schema.
 * Convex adds `_id` and `_creationTime` to every row; `_creationTime` is the
 * canonical "created at" timestamp, so no table stores one explicitly.
 */
export const FINDING_EMBEDDING_DIMENSIONS = 768;

export default defineSchema({
  products: defineTable({
    slug: v.string(),
    name: v.string(),
  }).index('by_slug', ['slug']),

  repos: defineTable({
    productId: v.id('products'),
    owner: v.string(),
    name: v.string(),
    fullName: v.string(),
    defaultBranch: v.string(),
  })
    .index('by_full_name', ['fullName'])
    .index('by_product', ['productId']),

  pullRequests: defineTable({
    repoId: v.id('repos'),
    number: v.number(),
    state: pullRequestState,
    draft: v.boolean(),
    headSha: v.string(),
    baseRef: v.string(),
    title: v.string(),
    author: v.string(),
    url: v.string(),
    reviewActive: v.boolean(),
    mergeStateSignalsRolledUpAt: v.optional(v.number()),
  })
    .index('by_repo_and_number', ['repoId', 'number'])
    .index('by_state_and_merge_state_signals_rolled_up_at', [
      'state',
      'mergeStateSignalsRolledUpAt',
    ]),

  reviewJobs: defineTable({
    pullRequestId: v.id('pullRequests'),
    repoId: v.id('repos'),
    headSha: v.string(),
    status: reviewJobStatus,
    trigger: reviewTrigger,
    agentKeys: v.array(v.string()),
    confidenceScore: confidence,
    agentRuns: v.array(v.id('agentRuns')),
    siblingShas,
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_status', ['status'])
    .index('by_status_and_claimed_at', ['status', 'claimedAt'])
    .index('by_pull_request', ['pullRequestId'])
    .index('by_pull_request_and_status', ['pullRequestId', 'status']),

  findings: defineTable({
    reviewJobId: v.id('reviewJobs'),
    pullRequestId: v.id('pullRequests'),
    agentKey: v.string(),
    severity,
    confidence,
    anchor: findingAnchor,
    crossRepoReferences: v.optional(v.array(crossRepoReference)),
    summary: v.string(),
    evidence: v.string(),
    suggestedFix: v.optional(v.string()),
    category: v.string(),
    embedding: v.optional(v.array(v.float64())),
    archetypeId: v.optional(v.id('archetypes')),
    // Set after the Finding is posted, linking it to its GitHub comment for the
    // Comment Trailer / reaction loop.
    githubCommentId: v.optional(v.number()),
  })
    .index('by_review_job', ['reviewJobId'])
    .index('by_pull_request', ['pullRequestId'])
    .index('by_archetype', ['archetypeId']),

  archetypes: defineTable({
    productId: v.id('products'),
    agentKey: v.string(),
    scopeKey: v.string(),
    label: v.string(),
    exemplarEmbedding: v.array(v.float64()),
    exampleFindingIds: v.array(v.id('findings')),
    count: v.number(),
    suppressionWeight: v.number(),
  })
    .index('by_product', ['productId'])
    .index('by_product_and_agent_key', ['productId', 'agentKey'])
    .vectorIndex('by_exemplar_embedding_and_scope_key', {
      vectorField: 'exemplarEmbedding',
      dimensions: FINDING_EMBEDDING_DIMENSIONS,
      filterFields: ['scopeKey', 'productId', 'agentKey'],
    }),

  reactions: defineTable({
    findingId: v.id('findings'),
    kind: reactionKind,
    replyText: v.optional(v.string()),
  }).index('by_finding', ['findingId']),

  suggestedRules: defineTable({
    productId: v.id('products'),
    type: suggestedRuleType,
    status: suggestedRuleStatus,
    description: v.string(),
    sourceArchetypeId: v.id('archetypes'),
    evidence: v.string(),
  })
    .index('by_status', ['status'])
    .index('by_source_archetype', ['sourceArchetypeId']),

  agentRuns: defineTable({
    reviewJobId: v.id('reviewJobs'),
    agentKey: v.string(),
    status: agentRunStatus,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    findingCount: v.number(),
    crossRepoSearch: v.optional(crossRepoSearchRationale),
    error: v.optional(v.string()),
  }).index('by_review_job', ['reviewJobId']),

  apiSurfaceManifests: defineTable({
    productId: v.id('products'),
    repoShas: v.array(
      v.object({
        repo: v.string(),
        sha: v.string(),
      }),
    ),
    markdown: v.string(),
    builtAt: v.number(),
  })
    .index('by_product', ['productId'])
    .index('by_product_and_built_at', ['productId', 'builtAt']),
});
