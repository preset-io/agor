/**
 * Compatibility helpers for the legacy `unix_username` field.
 *
 * Agor no longer creates, validates, or impersonates host Unix accounts. The
 * field remains temporarily as an opaque delegated-substrate home key.
 */
import { Forbidden } from '@feathersjs/errors';
import { unixUserModeRequiresExecutionHomeKey } from '../config/config-manager.js';
import type { UnixUserMode } from '../config/types.js';

/** Validate the conservative home-key syntax accepted by `{unix_user}` templates. */
export function isValidExecutionHomeKey(username: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(username);
}

export type { UnixUserMode };

export function assertExecutionHomeKeySatisfiesMode(
  homeKey: string | null | undefined,
  mode: UnixUserMode,
  subject = 'your account'
): void {
  if (!unixUserModeRequiresExecutionHomeKey(mode) || homeKey) return;
  throw new Forbidden(
    `unix_user_mode '${mode}' requires a unix_username home key, but ${subject} has none. ` +
      'Ask an admin to set one before creating sessions.'
  );
}

export interface DelegatedHomeKeyResolution {
  /** Opaque identity/home key forwarded to a delegated execution substrate. */
  delegatedHomeKey: string | null;
  reason: string;
}

export interface ResolveDelegatedHomeKeyOptions {
  mode: UnixUserMode;
  executionHomeKey?: string | null;
}

/**
 * Resolve the compatibility home key for external delegated execution.
 * Local `simple` and `sandbox` execution always run as the daemon user.
 */
export function resolveDelegatedHomeKey(
  options: ResolveDelegatedHomeKeyOptions
): DelegatedHomeKeyResolution {
  if (options.mode !== 'delegated') {
    return {
      delegatedHomeKey: null,
      reason: `${options.mode} mode - daemon-user execution`,
    };
  }
  if (!options.executionHomeKey) {
    throw new Error(
      'Delegated execution requires a unix_username home key to be set. ' +
        'Ensure the user has a unix_username configured.'
    );
  }
  if (!isValidExecutionHomeKey(options.executionHomeKey)) {
    throw new Error('Delegated unix_username home key has an invalid format.');
  }
  return {
    delegatedHomeKey: options.executionHomeKey,
    reason: `delegated mode - home key forwarded to execution substrate: ${options.executionHomeKey}`,
  };
}
