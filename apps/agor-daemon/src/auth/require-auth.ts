/**
 * The shared `requireAuth` hook factory — the single REST/Feathers auth
 * chokepoint. Composes the authentication strategy hook, the terminal-executor
 * rejection guard, and tenant resolution. Extracted from index.ts so the
 * composition (specifically that the terminal-executor guard is wired in) is
 * unit-testable and can't be silently dropped by a refactor.
 */

import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { rejectTerminalExecutorIdentity } from './terminal-executor-guard.js';

export type AuthHook = (context: HookContext) => Promise<HookContext>;

export function createRequireAuthHook(
  authenticatedHook: AuthHook,
  multiTenancy: ResolvedMultiTenancyConfig
): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authed = await authenticatedHook(context);
    // A terminal-executor identity is valid ONLY for the Socket.IO terminal
    // channel (handled outside Feathers); reject it from every REST/Feathers
    // service call here so it can't ride the RBAC rank table's viewer-rank
    // fallthrough into API access.
    await rejectTerminalExecutorIdentity(authed);
    try {
      authed.params.tenant = resolveTenantContext(multiTenancy, { params: authed.params });
      return authed;
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }
  };
}
