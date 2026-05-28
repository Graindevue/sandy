/**
 * Type stub for `@sandy/convex-backend/api`, wired in via `tsconfig` `paths`.
 *
 * `@sandy/convex-backend` ships its Convex functions as source `.ts` authored
 * for that package's own loose, Bundler-resolution tsconfig — not as built
 * declarations. Importing its generated `api.d.ts` directly drags those source
 * modules into bot-worker's program, where they fail this package's stricter
 * NodeNext / `verbatimModuleSyntax` type-check. Redirecting the *type* of the
 * import to this stub keeps the backend's source out of bot-worker's program.
 *
 * The runtime is unaffected: Node resolves the real package export at run time,
 * and the generated `api` is `anyApi` there regardless, so this stub matches the
 * real runtime value. The function references below name exactly the mutations
 * and queries this package calls; their argument shapes are pinned by the typed
 * `ReviewSink` / `ConvexSink` input types, and the Convex validators and
 * handlers are type-checked inside `@sandy/convex-backend` itself.
 */
declare module '@sandy/convex-backend/api' {
  import type { FunctionReference } from 'convex/server';

  type Mutation = FunctionReference<'mutation'>;
  type Query = FunctionReference<'query'>;

  export const api: {
    pullRequests: {
      ensureRepo: Mutation;
      get: Query;
      upsert: Mutation;
      setReviewActive: Mutation;
      clearOnClose: Mutation;
    };
    reviewJobs: {
      enqueue: Mutation;
    };
  };
}
