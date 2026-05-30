import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  agentRunStatus,
  pullRequestState,
  reviewJobStatus,
  reviewTrigger,
  severity,
} from './validators.js';

/**
 * Phase 1 schema. Archetype / reaction / suggestedRules tables land in Phase 3.
 * Convex adds `_id` and `_creationTime` to every row; `_creationTime` is the
 * canonical "created at" timestamp, so no table stores one explicitly.
 */
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
  }).index('by_repo_and_number', ['repoId', 'number']),

  reviewJobs: defineTable({
    pullRequestId: v.id('pullRequests'),
    repoId: v.id('repos'),
    headSha: v.string(),
    status: reviewJobStatus,
    trigger: reviewTrigger,
    agentKeys: v.array(v.string()),
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
    confidence: v.number(),
    repo: v.string(),
    path: v.string(),
    lineStart: v.number(),
    lineEnd: v.number(),
    summary: v.string(),
    evidence: v.string(),
    suggestedFix: v.optional(v.string()),
    category: v.string(),
    // Set after the Finding is posted, linking it to its GitHub comment for the
    // Comment Trailer / reaction loop.
    githubCommentId: v.optional(v.number()),
  })
    .index('by_review_job', ['reviewJobId'])
    .index('by_pull_request', ['pullRequestId']),

  agentRuns: defineTable({
    reviewJobId: v.id('reviewJobs'),
    agentKey: v.string(),
    status: agentRunStatus,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    findingCount: v.number(),
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
