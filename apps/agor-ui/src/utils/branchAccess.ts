import { BRANCH_PERMISSION_LEVELS, type EffectiveBranchAccess } from '@agor-live/client';

/** Creating sessions starts at `session`; `prompt` and `all` include it. */
export const canStartSessions = (access: Pick<EffectiveBranchAccess, 'can'>) =>
  BRANCH_PERMISSION_LEVELS.indexOf(access.can) >= BRANCH_PERMISSION_LEVELS.indexOf('session');
