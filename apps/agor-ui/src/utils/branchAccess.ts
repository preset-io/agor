import {
  type AgorClient,
  BRANCH_PERMISSION_LEVELS,
  type EffectiveBranchAccess,
} from '@agor-live/client';

/** Creating sessions starts at `session`; `prompt` and `all` include it. */
export const canStartSessions = (access: Pick<EffectiveBranchAccess, 'can'>) =>
  BRANCH_PERMISSION_LEVELS.indexOf(access.can) >= BRANCH_PERMISSION_LEVELS.indexOf('session');

/** The caller's legacy `{ can }` access to a branch, from `branches/:id/effective-access`. */
export const readBranchAccess = (client: AgorClient, branchId: string) =>
  client
    .service('branches/:id/effective-access')
    .find({ route: { id: branchId } }) as unknown as Promise<EffectiveBranchAccess>;
