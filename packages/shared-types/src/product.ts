/** Stable identifier for a Product (a Convex document id at runtime). */
export type ProductId = string;

/**
 * A group of GitHub repositories that together form one logical software
 * product. The unit at which Sandy reasons about cross-repo context. Declared
 * in `.config/bot.yaml`.
 */
export interface Product {
  id: ProductId;
  /** Stable slug used in config and logs, e.g. `"acme"`. */
  slug: string;
  /** Human-readable display name. */
  name: string;
}
