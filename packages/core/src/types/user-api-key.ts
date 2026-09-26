/**
 * Personal API keys: the shared contract between the daemon, the CLI and the UI.
 */

import type { UserID } from './id';
import type { TenantID } from './tenant';
import type { UserRole } from './user';

/** Every personal API key starts with this non-secret prefix. */
export const PERSONAL_API_KEY_PREFIX = 'agor_sk_';

/** Personal API key CRUD for the authenticated user. */
export const USER_API_KEYS_SERVICE_PATH = 'api/v1/user/api-keys';

/** Credential self-check: who am I, in which tenant, with which key. */
export const USER_IDENTITY_SERVICE_PATH = 'api/v1/user/me';

/**
 * Where a key came from. `manual` keys are created in settings; `cli_login`
 * keys are minted per machine by `agor login` and deleted by `agor logout`.
 */
export const USER_API_KEY_SOURCES = ['manual', 'cli_login'] as const;
export type UserApiKeySource = (typeof USER_API_KEY_SOURCES)[number];

export function isUserApiKeySource(value: unknown): value is UserApiKeySource {
  return typeof value === 'string' && (USER_API_KEY_SOURCES as readonly string[]).includes(value);
}

/** `POST api/v1/user/api-keys` body. */
export interface CreateUserApiKeyRequest {
  name: string;
  source?: UserApiKeySource;
  /** Only for `cli_login`: retire this user's earlier CLI key with the same name. */
  replace_previous?: boolean;
}

/** `GET api/v1/user/me` response. */
export interface CurrentUserIdentity {
  user_id: UserID;
  email: string;
  name?: string;
  role: UserRole;
  tenant_id?: TenantID;
  auth_strategy?: string;
  /** Present when the request authenticated with a personal API key (never the secret). */
  api_key_id?: string;
  api_key_source?: UserApiKeySource;
}
