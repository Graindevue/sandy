import { normalizeProductRuleLine, type ProductRuleLineDrafter } from './product-rule-drafter.js';
import type {
  PendingPositivePromotion,
  PositivePromotionStore,
  ProductRuleGitHub,
  ProductRulesPullRequest,
  PromotionRepo,
  PromotionWorkerLogger,
} from './promotion-types.js';

export interface PositivePromotionPromoterOptions {
  github: ProductRuleGitHub;
  store: PositivePromotionStore;
  resolveAgentKeys: (repo: PromotionRepo) => readonly string[];
  draftRuleLine: ProductRuleLineDrafter;
  logger: PromotionWorkerLogger;
}

export class PositivePromotionPromoter {
  readonly #github: ProductRuleGitHub;
  readonly #store: PositivePromotionStore;
  readonly #resolveAgentKeys: (repo: PromotionRepo) => readonly string[];
  readonly #draftRuleLine: ProductRuleLineDrafter;
  readonly #logger: PromotionWorkerLogger;

  constructor(options: PositivePromotionPromoterOptions) {
    this.#github = options.github;
    this.#store = options.store;
    this.#resolveAgentKeys = options.resolveAgentKeys;
    this.#draftRuleLine = options.draftRuleLine;
    this.#logger = options.logger;
  }

  async promote(rule: PendingPositivePromotion): Promise<void> {
    const ruleLine = normalizeProductRuleLine(await this.#draftRuleLine(rule), rule);
    const pullRequest = await this.#github.openProductRulesPullRequest({
      repo: {
        owner: rule.targetRepo.owner,
        name: rule.targetRepo.name,
        defaultBranch: rule.targetRepo.defaultBranch,
      },
      suggestedRuleId: rule._id,
      ruleLine,
    });
    const record = await this.#store.recordPositivePromotion({
      suggestedRuleId: rule._id,
      repoId: rule.targetRepo._id,
      pullRequest: promotionPullRequestRecord(pullRequest),
      agentKeys: [...this.#resolveAgentKeys(rule.targetRepo)],
    });
    if (!record.promoted) {
      this.#logger.warn(
        `Skipped marking SuggestedRule ${rule._id} promoted because its status changed`,
      );
      return;
    }
    this.#logger.info(
      `Promoted SuggestedRule ${rule._id} to product rule PR ${rule.targetRepo.fullName}#${pullRequest.number}`,
    );
  }
}

function promotionPullRequestRecord(pullRequest: ProductRulesPullRequest): ProductRulesPullRequest {
  return {
    number: pullRequest.number,
    draft: pullRequest.draft,
    headSha: pullRequest.headSha,
    baseRef: pullRequest.baseRef,
    title: pullRequest.title,
    author: pullRequest.author,
    url: pullRequest.url,
    state: pullRequest.state,
  };
}
