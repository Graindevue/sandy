import type { UserIdentity } from 'convex/server';
import { vi } from 'vitest';

export const serviceIdentity: UserIdentity = {
  tokenIdentifier:
    'https://token.actions.githubusercontent.com|repo:acme/widget:environment:sandy-codex',
  issuer: 'https://token.actions.githubusercontent.com',
  subject: 'repo:acme/widget:environment:sandy-codex',
  environment: 'sandy-codex',
  repository_id: '123',
  workflow_ref: 'acme/widget/.github/workflows/sandy-review.yml@refs/heads/main',
  repository_visibility: 'private',
  event_name: 'issue_comment',
  run_attempt: '1',
};

export const serviceAuth = { getUserIdentity: async () => serviceIdentity };

export function stubReviewServiceConfig(): void {
  vi.stubEnv('SANDY_AUTH_REPOSITORY_ID', '123');
  vi.stubEnv('SANDY_AUTH_WORKFLOW_REF', String(serviceIdentity.workflow_ref));
  vi.stubEnv('SANDY_AUTH_ENVIRONMENT', 'sandy-codex');
}
