export interface ReviewBotRepoContext {
  repo: {
    fullName: string;
  };
  agentsYaml: string | null;
}

export interface ReviewBotContext {
  repoRules: string | null;
  productRules: string | null;
  ignorePatterns: readonly string[];
  repos?: readonly ReviewBotRepoContext[];
}

export const EMPTY_REVIEW_BOT_CONTEXT: ReviewBotContext = {
  repoRules: null,
  productRules: null,
  ignorePatterns: [],
};
