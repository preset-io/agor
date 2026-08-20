/**
 * useAuthConfig - Fetch daemon authentication and instance configuration
 *
 * Retrieves auth config and instance info from the daemon's health endpoint.
 * Used on app startup to determine if login page should be shown and display instance label.
 */

import type { ResolvedIdentityAuthority } from '@agor/core/config/browser';
import type { ManagedEnvExecutionMode } from '@agor/core/environment/webhook';
import type { UploadIngressPolicy } from '@agor/core/types';
import { useEffect, useSyncExternalStore } from 'react';
import { getDaemonUrl } from '../config/daemon';
import type { BranchStorageConfig } from '../utils/branchStorage';

export interface AuthConfig {
  requireAuth: boolean;
  identity?: ResolvedIdentityAuthority;
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
  /**
   * Resolved branch storage policy from execution.branch_storage.
   * Defaults server-side to { defaultMode: 'worktree',
   * allowedModes: ['worktree', 'clone'] } when unset.
   */
  branchStorage?: BranchStorageConfig;
  /** Resolved upload limits enforced by the daemon. */
  uploadPolicy?: UploadIngressPolicy;
}

interface HealthResponse {
  status: string;
  timestamp: number;
  version: string;
  database: string;
  auth: AuthConfig;
  instance?: InstanceConfig;
  features?: FeaturesConfig;
}

interface AuthConfigState {
  config: AuthConfig | null;
  instanceConfig: InstanceConfig | null;
  featuresConfig: FeaturesConfig | undefined;
  loading: boolean;
  error: Error | null;
}

let snapshot: AuthConfigState = {
  config: null,
  instanceConfig: null,
  featuresConfig: undefined,
  loading: true,
  error: null,
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
  };
  request = null;
}

/** Seed the already-loaded app-shell snapshot for isolated component tests. */
export function __setAuthConfigForTests(config: AuthConfig): void {
  snapshot = {
    config,
    instanceConfig: null,
    featuresConfig: undefined,
    loading: false,
    error: null,
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

function fetchAuthConfigOnce(): Promise<void> {
  if (request) return request;
  request = (async () => {
    try {
      const response = await fetch(`${getDaemonUrl()}/health`);
      if (!response.ok) {
        throw new Error(`Failed to fetch auth config: ${response.statusText}`);
      }

      const health: HealthResponse = await response.json();
      publish({
        config: health.auth,
        instanceConfig: health.instance ?? null,
        featuresConfig: health.features,
        loading: false,
        error: null,
      });
    } catch (err) {
      publish({
        // Default to requiring auth on error (secure by default). Capability
        // consumers also inspect `error` and keep mutation controls disabled.
        config: { requireAuth: true },
        instanceConfig: null,
        featuresConfig: undefined,
        loading: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  })();
  return request;
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
