import type { ProductId } from './product.js';

/** Stable identifier for a Repo (a Convex document id at runtime). */
export type RepoId = string;

/** A single GitHub repository. Belongs to exactly one Product. */
export interface Repo {
  id: RepoId;
  productId: ProductId;
  /** GitHub owner or org login, e.g. `"tony-co"`. */
  owner: string;
  /** Repository name, e.g. `"sandy"`. */
  name: string;
  /** Convenience `"owner/name"`. */
  fullName: string;
  /** Default branch, e.g. `"main"`. */
  defaultBranch: string;
}
