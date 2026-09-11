import type { Params } from '@agor/core/types';

export type TrustedUserMutationPurpose = 'avatar-sync' | 'env-vars-widget' | 'claude-auth';

const TRUSTED_USER_MUTATION_PARAM = Symbol('agor.users.trusted-mutation');

interface TrustedUserMutationParams extends Params {
  [TRUSTED_USER_MUTATION_PARAM]?: TrustedUserMutationPurpose;
}

/**
 * Mark a narrowly-scoped in-process users.patch call.
 *
 * A symbol is intentionally used instead of a serializable parameter so REST,
 * Socket.IO, and MCP callers cannot forge a trusted mutation purpose.
 */
export function markTrustedUserMutation(params: Params, purpose: TrustedUserMutationPurpose): void {
  (params as TrustedUserMutationParams)[TRUSTED_USER_MUTATION_PARAM] = purpose;
}

export function getTrustedUserMutationPurpose(
  params: Params | undefined
): TrustedUserMutationPurpose | undefined {
  if (!params || params.provider) return undefined;
  return (params as TrustedUserMutationParams)[TRUSTED_USER_MUTATION_PARAM];
}
