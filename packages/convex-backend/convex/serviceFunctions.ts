import { ConvexError } from 'convex/values';
import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from 'convex-helpers/server/customFunctions';
import {
  action as baseAction,
  mutation as baseMutation,
  query as baseQuery,
  type QueryCtx,
} from './_generated/server.js';

/** This deployment belongs to one trusted service, not a shared tenant API. */
async function requireReviewService(
  ctx: Pick<QueryCtx, 'auth'>,
): Promise<{ serviceAuthenticated: true }> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const repositoryId = env?.SANDY_AUTH_REPOSITORY_ID;
  const workflowRef = env?.SANDY_AUTH_WORKFLOW_REF;
  const environment = env?.SANDY_AUTH_ENVIRONMENT;
  const identity = await ctx.auth.getUserIdentity();
  if (
    !repositoryId ||
    !workflowRef ||
    !environment ||
    identity === null ||
    identity.issuer !== 'https://token.actions.githubusercontent.com' ||
    identity.repository_id !== repositoryId ||
    identity.workflow_ref !== workflowRef ||
    identity.environment !== environment ||
    identity.repository_visibility !== 'private' ||
    identity.event_name !== 'issue_comment' ||
    identity.run_attempt !== '1'
  ) {
    throw new ConvexError('Unauthorized');
  }
  return { serviceAuthenticated: true };
}

// All public entry points share this guard; internal cron functions do not mint
// or impersonate a service identity. Never import public builders directly.
export const query = customQuery(baseQuery, customCtx(requireReviewService));
export const mutation = customMutation(baseMutation, customCtx(requireReviewService));
export const action = customAction(baseAction, customCtx(requireReviewService));
