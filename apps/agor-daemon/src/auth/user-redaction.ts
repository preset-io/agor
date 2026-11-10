import type { User } from '@agor/core/types';

/** Profile fields any tenant reader may see on another user: identity and attribution only. */
const USER_DIRECTORY_FIELDS = [
  'user_id',
  'email',
  'name',
  'emoji',
  'avatar_url',
  'avatar',
  'avatar_source',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof User)[];

export type UserDirectoryEntry = Partial<Pick<User, (typeof USER_DIRECTORY_FIELDS)[number]>> & {
  preferences?: Pick<NonNullable<User['preferences']>, 'use_slack_avatar'>;
};

/**
 * Project a user to what callers other than the user and admins may read.
 *
 * Role, execution home key, credential inventory (`env_vars`, `agentic_*`),
 * defaults, external identity links and account state stay with the owner and
 * admins. Email stays because attribution and pickers fall back to it. `use_slack_avatar`
 * is kept because avatar rendering honours it for every viewer.
 */
export function toUserDirectoryEntry(user: Partial<User>): UserDirectoryEntry {
  const entry = Object.fromEntries(
    USER_DIRECTORY_FIELDS.filter((field) => user[field] !== undefined).map((field) => [
      field,
      user[field],
    ])
  ) as UserDirectoryEntry;
  const useSlackAvatar = user.preferences?.use_slack_avatar;
  if (useSlackAvatar !== undefined) entry.preferences = { use_slack_avatar: useSlackAvatar };
  return entry;
}

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
