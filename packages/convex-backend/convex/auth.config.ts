import type { AuthConfig } from 'convex/server';

/** GitHub verifies the job identity; serviceFunctions restricts the accepted job. */
export default {
  providers: [
    {
      type: 'customJwt',
      issuer: 'https://token.actions.githubusercontent.com',
      jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      algorithm: 'RS256',
      applicationID: 'sandy-review',
    },
  ],
} satisfies AuthConfig;
