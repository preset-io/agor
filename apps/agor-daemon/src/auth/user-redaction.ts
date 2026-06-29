import type { User } from '@agor/core/types';

type UserWithBackendFields = User & {
  tokens_valid_after?: unknown;
  password?: unknown;
  tenant_id?: unknown;
};

/**
 * Remove backend-only auth metadata before returning a user object to browser clients.
 */
export function redactUserAuthMetadata(user: UserWithBackendFields): User {
  const {
    tokens_valid_after: _tokensValidAfter,
    password: _password,
    tenant_id: _tenantId,
    ...publicUser
  } = user;
  return publicUser;
}
