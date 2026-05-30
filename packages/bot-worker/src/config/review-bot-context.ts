export interface ReviewBotContext {
  repoRules: string | null;
  productRules: string | null;
  ignorePatterns: readonly string[];
}

export const EMPTY_REVIEW_BOT_CONTEXT: ReviewBotContext = {
  repoRules: null,
  productRules: null,
  ignorePatterns: [],
};
