/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentRuns from "../agentRuns.js";
import type * as apiSurfaceManifests from "../apiSurfaceManifests.js";
import type * as archetypeLabels from "../archetypeLabels.js";
import type * as archetypes from "../archetypes.js";
import type * as crons from "../crons.js";
import type * as findings from "../findings.js";
import type * as openaiEmbeddings from "../openaiEmbeddings.js";
import type * as products from "../products.js";
import type * as pullRequests from "../pullRequests.js";
import type * as reactions from "../reactions.js";
import type * as reviewJobReaper from "../reviewJobReaper.js";
import type * as reviewJobs from "../reviewJobs.js";
import type * as suggestedRules from "../suggestedRules.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentRuns: typeof agentRuns;
  apiSurfaceManifests: typeof apiSurfaceManifests;
  archetypeLabels: typeof archetypeLabels;
  archetypes: typeof archetypes;
  crons: typeof crons;
  findings: typeof findings;
  openaiEmbeddings: typeof openaiEmbeddings;
  products: typeof products;
  pullRequests: typeof pullRequests;
  reactions: typeof reactions;
  reviewJobReaper: typeof reviewJobReaper;
  reviewJobs: typeof reviewJobs;
  suggestedRules: typeof suggestedRules;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
