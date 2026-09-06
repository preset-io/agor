/**
 * useAuthConfig - Fetch daemon authentication and instance configuration
 *
 * Retrieves auth config and instance info from the daemon's health endpoint.
 * Used on app startup to determine if login page should be shown and display instance label.
 */

import {
  AgorExternalIdentityProvider,
  AgorExternalIdentityProvisioning,
  AgorLocalAuthMode,
  AgorPasswordPolicyProfile,
  AgorRoleAuthority,
  AgorUserLifecycleAuthority,
  IDENTITY_AUTHORITY_CONTRACT_VERSION,
  type PasswordPolicyRequirements,
  type ResolvedIdentityAuthority,
} from '@agor/core/config/browser';
import type { ManagedEnvExecutionMode } from '@agor/core/environment/webhook';
import type { UploadIngressPolicy } from '@agor/core/types';
import { useEffect, useSyncExternalStore } from 'react';
import { getDaemonUrl } from '../config/daemon';
import type { BranchStorageConfig } from '../utils/branchStorage';

export interface AuthConfig {
  requireAuth: boolean;
  identity?: ResolvedIdentityAuthority;
  /** Safe hints for local password forms; the daemon remains authoritative. */
  passwordPolicy?: PasswordPolicyRequirements;
  externalLaunch?: {
    enabled?: boolean;
    loginRedirectUrl?: string;
    /**
     * Query parameter name the UI appends to `loginRedirectUrl` carrying the
     * current browser host as an opaque return context for direct-host entry.
     * The launch issuer allow-lists this value against its routing records.
     */
    returnHostParam?: string;
  };
}

interface InstanceConfig {
  label?: string;
  description?: string;
}

export interface FeaturesConfig {
  /** Operator-selected repository used to bootstrap the first teammate. */
  teammateFrameworkRepoUrl?: string;
  /**
   * Whether the web terminal is enabled for members (execution.allow_web_terminal).
   * Defaults to true when the daemon config key is unset.
   */
  webTerminal?: boolean;
  /** Process/runtime ownership contract advertised by the daemon. */
  webTerminalCapability?: {
    enabled: boolean;
    mode: 'owner-local-ephemeral' | 'disabled';
    reason?: string;
  };
  /**
   * How managed environment lifecycle fields are handled by this instance.
   * Defaults to 'hybrid': shell commands and URL webhooks are both supported.
   */
  managedEnvsExecutionMode?: ManagedEnvExecutionMode;
  /**
   * True when the daemon enforces the local multi-user filesystem sandbox. The UI uses this to hide "trust everyone on this
   * instance" surfaces (e.g. the `instance` scope option in the artifact
   * consent modal). Server-side gates are the source of truth.
   */
  multiUser?: boolean;
  /** Experimental Cursor SDK provider enabled on the daemon. */
  cursorSdk?: boolean;
  /** Daemon-driven Claude subscription OAuth is explicitly operator-authorized. */
  claudeSubscriptionOAuth?: boolean;
  /**
   * Resolved branch storage policy from execution.branch_storage.
   * Defaults server-side to { defaultMode: 'worktree',
   * allowedModes: ['worktree', 'clone'] } when unset.
   */
  branchStorage?: BranchStorageConfig;
  /** Resolved upload limits enforced by the daemon. */
  uploadPolicy?: UploadIngressPolicy;
  /** @deprecated Compatibility field from older daemons; current RBAC is always enabled. */
  branchRbac?: boolean;
}

interface HealthResponse {
  status: string;
  timestamp: number;
  version: string;
  database: string;
  auth: unknown;
  instance?: InstanceConfig;
  features?: FeaturesConfig;
}

export const IdentityContractState = {
  UNKNOWN: 'unknown',
  LEGACY: 'legacy',
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
} as const;
export type IdentityContractState =
  (typeof IdentityContractState)[keyof typeof IdentityContractState];

export interface AuthConfigState {
  config: AuthConfig | null;
  instanceConfig: InstanceConfig | null;
  featuresConfig: FeaturesConfig | undefined;
  loading: boolean;
  error: Error | null;
  identityContractState: IdentityContractState;
  /** Retry a failed or unsupported health-contract load without remounting. */
  retry: () => void;
}

let snapshot: AuthConfigState = {
  config: null,
  instanceConfig: null,
  featuresConfig: undefined,
  loading: true,
  error: null,
  identityContractState: IdentityContractState.UNKNOWN,
  retry: retryAuthConfig,
};
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Reset the module cache between isolated component tests. */
export function __resetAuthConfigForTests(): void {
  snapshot = {
    config: null,
    instanceConfig: null,
    featuresConfig: undefined,
    loading: true,
    error: null,
    identityContractState: IdentityContractState.UNKNOWN,
    retry: retryAuthConfig,
  };
  request = null;
}

/** Seed the already-loaded app-shell snapshot for isolated component tests. */
export function __setAuthConfigForTests(config: AuthConfig, featuresConfig?: FeaturesConfig): void {
  const identityContractState = config.identity
    ? isResolvedIdentityAuthority(config.identity)
      ? IdentityContractState.SUPPORTED
      : IdentityContractState.UNSUPPORTED
    : IdentityContractState.LEGACY;
  snapshot = {
    config: identityContractState === IdentityContractState.UNSUPPORTED ? null : config,
    instanceConfig: null,
    featuresConfig,
    loading: false,
    error:
      identityContractState === IdentityContractState.UNSUPPORTED
        ? new Error('Unsupported daemon identity capability contract')
        : null,
    identityContractState,
    retry: retryAuthConfig,
  };
  request = Promise.resolve();
}

function publish(next: AuthConfigState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type UserIdentityCapability = keyof ResolvedIdentityAuthority['capabilities']['users'];

const USER_IDENTITY_CAPABILITIES = {
  create: true,
  delete: true,
  identityWrite: true,
  roleWrite: true,
  passwordWrite: true,
  avatarSettingsWrite: true,
  selfConfigurationWrite: true,
} as const satisfies Record<UserIdentityCapability, true>;

function isEnumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isResolvedIdentityAuthority(value: unknown): value is ResolvedIdentityAuthority {
  if (!isRecord(value)) return false;
  if (value.contractVersion !== IDENTITY_AUTHORITY_CONTRACT_VERSION) return false;
  if (!isEnumValue(Object.values(AgorUserLifecycleAuthority), value.userLifecycle)) {
    return false;
  }
  if (!isEnumValue(Object.values(AgorRoleAuthority), value.roleAuthority)) return false;
  if (!isEnumValue(Object.values(AgorLocalAuthMode), value.localAuth)) return false;

  const capabilities = value.capabilities;
  if (!isRecord(capabilities) || !isRecord(capabilities.users)) return false;
  const users = capabilities.users;
  for (const capability of Object.keys(USER_IDENTITY_CAPABILITIES)) {
    if (typeof users[capability] !== 'boolean') return false;
  }
  if (users.selfConfigurationWrite !== true) return false;

  const externallyManaged = value.userLifecycle === AgorUserLifecycleAuthority.EXTERNAL;
  if (externallyManaged) {
    if (value.roleAuthority !== AgorRoleAuthority.CLAIMS) return false;
    if (value.localAuth !== AgorLocalAuthMode.DISABLED) return false;
    if (!isRecord(value.external)) return false;
    if (value.external.provider !== AgorExternalIdentityProvider.EXTERNAL_LAUNCH) return false;
    if (value.external.provisioning !== AgorExternalIdentityProvisioning.JIT) return false;
  } else {
    if (value.roleAuthority !== AgorRoleAuthority.INTERNAL) return false;
    if (value.localAuth !== AgorLocalAuthMode.ENABLED) return false;
    if (value.external !== undefined) return false;
  }

  return (
    users.create === !externallyManaged &&
    users.delete === !externallyManaged &&
    users.identityWrite === !externallyManaged &&
    users.roleWrite === (value.roleAuthority === AgorRoleAuthority.INTERNAL) &&
    users.passwordWrite === (value.localAuth === AgorLocalAuthMode.ENABLED && !externallyManaged) &&
    users.avatarSettingsWrite === !externallyManaged
  );
}

function isPasswordPolicyRequirements(value: unknown): value is PasswordPolicyRequirements {
  if (!isRecord(value)) return false;
  return (
    value.profile === AgorPasswordPolicyProfile.SECURE &&
    Number.isSafeInteger(value.min_length) &&
    (value.min_length as number) > 0 &&
    Number.isSafeInteger(value.max_utf8_bytes) &&
    (value.max_utf8_bytes as number) > 0 &&
    value.common_passwords_rejected === true &&
    (value.blocklist_version === undefined ||
      (typeof value.blocklist_version === 'string' && value.blocklist_version.length > 0)) &&
    value.composition_rules === false &&
    value.periodic_rotation_required === false
  );
}

function parseAuthConfig(value: unknown): {
  config: AuthConfig | null;
  identityContractState: IdentityContractState;
  error: Error | null;
} {
  if (!isRecord(value) || typeof value.requireAuth !== 'boolean') {
    throw new Error('Daemon returned an invalid authentication configuration');
  }
  if (value.passwordPolicy !== undefined && !isPasswordPolicyRequirements(value.passwordPolicy)) {
    throw new Error('Daemon returned invalid password policy requirements');
  }

  const identity = value.identity;
  if (identity === undefined) {
    // A pre-contract daemon is intentionally permissive for mixed-version
    // rollout. Server authorization remains authoritative.
    return {
      config: value as unknown as AuthConfig,
      identityContractState: IdentityContractState.LEGACY,
      error: null,
    };
  }
  if (!isResolvedIdentityAuthority(identity)) {
    return {
      config: null,
      identityContractState: IdentityContractState.UNSUPPORTED,
      error: new Error('Unsupported or malformed daemon identity capability contract'),
    };
  }
  if (value.passwordPolicy !== undefined && identity.localAuth !== AgorLocalAuthMode.ENABLED) {
    return {
      config: null,
      identityContractState: IdentityContractState.UNSUPPORTED,
      error: new Error('Password policy requirements conflict with disabled local authentication'),
    };
  }
  return {
    config: value as unknown as AuthConfig,
    identityContractState: IdentityContractState.SUPPORTED,
    error: null,
  };
}

/** Legacy daemons remain permissive; unknown or invalid contracts fail closed. */
export function isIdentityCapabilityAvailable(
  config: AuthConfig | null,
  contractState: IdentityContractState,
  capability: UserIdentityCapability
): boolean {
  if (contractState === IdentityContractState.LEGACY) return true;
  return (
    contractState === IdentityContractState.SUPPORTED &&
    config?.identity?.capabilities.users[capability] === true
  );
}

function fetchAuthConfigOnce(): Promise<void> {
  if (request) return request;
  const currentRequest = (async () => {
    try {
      const response = await fetch(`${getDaemonUrl()}/health`);
      if (!response.ok) {
        throw new Error(`Failed to fetch auth config: ${response.statusText}`);
      }

      const health: HealthResponse = await response.json();
      const parsed = parseAuthConfig(health.auth);
      publish({
        config: parsed.config,
        instanceConfig: health.instance ?? null,
        featuresConfig: health.features,
        loading: false,
        error: parsed.error,
        identityContractState: parsed.identityContractState,
        retry: retryAuthConfig,
      });
    } catch (err) {
      publish({
        // Keep config absent so the app shell shows its configuration-error
        // state rather than synthesizing a potentially wrong login policy.
        config: null,
        instanceConfig: null,
        featuresConfig: undefined,
        loading: false,
        error: err instanceof Error ? err : new Error(String(err)),
        identityContractState: IdentityContractState.UNKNOWN,
        retry: retryAuthConfig,
      });
    }
  })();
  request = currentRequest;
  void currentRequest.finally(() => {
    // Successful health remains cached for the app lifetime. A transient
    // failure releases the singleton so the mounted shell's action can retry.
    if (snapshot.error && request === currentRequest) request = null;
  });
  return currentRequest;
}

/** Retry in place so the app-shell error state can recover without a reload. */
export function retryAuthConfig(): void {
  if (snapshot.loading || !snapshot.error) return;
  request = null;
  publish({
    ...snapshot,
    loading: true,
    error: null,
    identityContractState: IdentityContractState.UNKNOWN,
    retry: retryAuthConfig,
  });
  void fetchAuthConfigOnce();
}

/** One shared health snapshot for the whole UI; consumers never refetch or drift. */
export function useAuthConfig(): AuthConfigState {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  );
  useEffect(() => {
    void fetchAuthConfigOnce();
  }, []);
  return state;
}
