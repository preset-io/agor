type BackendUserAuthFields = {
  tokens_valid_after?: unknown;
  credential_generation?: unknown;
  password?: unknown;
  tenant_id?: unknown;
};

/**
 * Remove backend-only auth metadata before returning a user object to browser clients.
 */
export function redactUserAuthMetadata<T extends object>(
  user: T
): Omit<T, keyof BackendUserAuthFields> {
  const {
    tokens_valid_after: _tokensValidAfter,
    credential_generation: _credentialGeneration,
    password: _password,
    tenant_id: _tenantId,
    ...publicUser
  } = user as T & BackendUserAuthFields;
  return publicUser as Omit<T, keyof BackendUserAuthFields>;
}
