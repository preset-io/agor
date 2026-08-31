/** Daemon-owned task credential resolution for managed Claude OAuth grants. */

import { join } from 'node:path';
import {
  compareAndSwapCredentialFile,
  readCredentialAuthorityFile,
  type readCredentialFile,
} from '@agor/core/codex/credential-file';
import {
  type AgorConfig,
  hasContainedClaudeRuntimeCredentials,
  resolveProviderConnection,
} from '@agor/core/config';
import {
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, Unavailable } from '@agor/core/feathers';
import type { DeepReadonly, UserID } from '@agor/core/types';
import { sandboxManagedCredentialIsolationAvailable } from '../utils/sandbox-wrap.js';
import {
  type ClaudeCredentialMutationCoordinator,
  claudeCredentialMutationKey,
  type ExchangedTokens,
  refreshClaudeTokens,
  TokenExchangeError,
} from './claude-oauth.js';
import { resolveCodexCredentialRoute } from './codex-auth-shared.js';

/** Refresh early enough that a normal task does not inherit an almost-dead token. */
export const CLAUDE_RUNTIME_REFRESH_MARGIN_MS = 60 * 60 * 1000;

interface ClaudeCredentialDocument extends Record<string, unknown> {
  claudeAiOauth: Record<string, unknown> & {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string | null;
  };
}

function buildRefreshedCredential(
  current: ClaudeCredentialDocument,
  tokens: ExchangedTokens,
  now: number
): string {
  // Preserve provider/runtime metadata we do not interpret (for example a
  // rate-limit tier) while replacing every field whose authority came from the
  // refresh response.
  return `${JSON.stringify(
    {
      ...current,
      claudeAiOauth: {
        ...current.claudeAiOauth,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now + tokens.expiresInSec * 1000,
        scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType ?? current.claudeAiOauth.subscriptionType ?? null,
      },
    },
    null,
    2
  )}\n`;
}

export interface ClaudeRuntimeCredentialDependencies {
  now?: () => number;
  refresh?: typeof refreshClaudeTokens;
  read?: typeof readCredentialFile;
  compareAndSwap?: typeof compareAndSwapCredentialFile;
  runtimeIsolationAvailable?: () => boolean;
}

function parseCredential(content: string): ClaudeCredentialDocument | null {
  try {
    const parsed = JSON.parse(content) as Partial<ClaudeCredentialDocument>;
    const oauth = parsed.claudeAiOauth;
    if (
      !oauth ||
      typeof oauth.accessToken !== 'string' ||
      !oauth.accessToken.startsWith('sk-ant-oat') ||
      typeof oauth.refreshToken !== 'string' ||
      !oauth.refreshToken.startsWith('sk-ant-ort') ||
      typeof oauth.expiresAt !== 'number' ||
      !Number.isFinite(oauth.expiresAt) ||
      !Array.isArray(oauth.scopes) ||
      !oauth.scopes.every((scope) => typeof scope === 'string') ||
      (oauth.subscriptionType !== undefined &&
        oauth.subscriptionType !== null &&
        typeof oauth.subscriptionType !== 'string')
    ) {
      return null;
    }
    return parsed as ClaudeCredentialDocument;
  } catch {
    return null;
  }
}

function usableWithoutRefresh(
  credential: ClaudeCredentialDocument,
  now: number,
  marginMs = CLAUDE_RUNTIME_REFRESH_MARGIN_MS
): boolean {
  return credential.claudeAiOauth.expiresAt - now >= marginMs;
}

function runtimeConnection(accessToken: string) {
  return {
    connection: { CLAUDE_CODE_OAUTH_TOKEN: accessToken },
    useNativeAuth: false as const,
  };
}

/**
 * Resolve the access token for one managed-file task launch.
 *
 * `.credentials.json` remains the canonical refreshable store, but it is read
 * and refreshed only by the daemon. The executor receives a bounded access
 * token through the existing sensitive config/resolve-api-key channel and is
 * never instructed to use native auth.
 */
export class ClaudeRuntimeCredentialResolver {
  private readonly flights = new Map<string, Promise<ReturnType<typeof runtimeConnection>>>();
  private readonly now: () => number;
  private readonly refresh: typeof refreshClaudeTokens;
  private readonly read: typeof readCredentialFile;
  private readonly compareAndSwap: typeof compareAndSwapCredentialFile;
  private readonly runtimeIsolationAvailable: () => boolean;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>,
    private readonly authority: ClaudeCredentialMutationCoordinator,
    dependencies: ClaudeRuntimeCredentialDependencies = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.refresh = dependencies.refresh ?? refreshClaudeTokens;
    this.read = dependencies.read ?? readCredentialAuthorityFile;
    this.compareAndSwap =
      dependencies.compareAndSwap ??
      ((options) => compareAndSwapCredentialFile({ ...options, preserveAuthorityInodes: true }));
    this.runtimeIsolationAvailable =
      dependencies.runtimeIsolationAvailable ?? sandboxManagedCredentialIsolationAvailable;
  }

  async resolve(tenantId: string, userId: UserID): Promise<ReturnType<typeof runtimeConnection>> {
    if (
      this.config.deployment?.mode === 'ha' ||
      !hasContainedClaudeRuntimeCredentials(this.config)
    ) {
      throw new BadRequest(
        'Managed Claude subscription login requires a contained per-user sandbox. Use an API key or pasted subscription token in this execution mode.'
      );
    }
    if (!this.runtimeIsolationAvailable()) {
      throw new BadRequest(
        'Managed Claude subscription login requires verified bubblewrap isolation with a private PID namespace on this host. Use an API key or pasted subscription token.'
      );
    }
    const route = await this.route(tenantId, userId);
    const target = join(route.claudeConfigDir, '.credentials.json');
    const observed = await this.readCredential(target);
    if (usableWithoutRefresh(observed.parsed, this.now())) {
      // Deliberately lock-free and network-free: access tokens are immutable
      // inputs to a task launch, and logout/source changes fence all writes.
      return runtimeConnection(observed.parsed.claudeAiOauth.accessToken);
    }

    const key = `${tenantId}:${userId}`;
    const current = this.flights.get(key);
    if (current) return current;
    const flight = this.refreshAndResolve({ tenantId, userId, target }).finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }

  private async route(tenantId: string, userId: UserID) {
    const route = await resolveCodexCredentialRoute(
      userId,
      <T>(work: (db: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(this.db, tenantId, work),
      this.config
    );
    if (!route.ok || !route.claudeConfigDir) {
      throw new BadRequest(
        'Managed Claude subscription login is unavailable for this execution home. Use an API key or pasted subscription token.'
      );
    }
    return { ...route, claudeConfigDir: route.claudeConfigDir };
  }

  private async readCredential(target: string): Promise<{
    raw: string;
    parsed: ClaudeCredentialDocument;
  }> {
    let raw: string;
    try {
      raw = await this.read(target);
    } catch {
      throw new BadRequest('The managed Claude login is unavailable. Sign in again.');
    }
    const parsed = parseCredential(raw);
    if (!parsed) throw new BadRequest('The managed Claude login is invalid. Sign in again.');
    return { raw, parsed };
  }

  private async sourceIsStillManaged(tenantId: string, userId: UserID): Promise<boolean> {
    const result = await runWithTenantDatabaseScope(this.db, tenantId, (tenantDb) =>
      resolveProviderConnection('claude-code', { userId, db: tenantDb })
    );
    return result.source === 'user' && result.useNativeAuth;
  }

  private async refreshAndResolve(input: {
    tenantId: string;
    userId: UserID;
    target: string;
  }): Promise<ReturnType<typeof runtimeConnection>> {
    // Another task may have completed a refresh before it joined this flight.
    const observed = await this.readCredential(input.target);
    if (usableWithoutRefresh(observed.parsed, this.now())) {
      return runtimeConnection(observed.parsed.claudeAiOauth.accessToken);
    }

    const oauth = observed.parsed.claudeAiOauth;
    let refreshed: ExchangedTokens;
    try {
      // SECURITY/AVAILABILITY: never hold the credential authority, a database
      // transaction, or the filesystem flock across provider I/O.
      refreshed = await this.refresh(oauth.refreshToken, {
        scopes: oauth.scopes,
        subscriptionType: oauth.subscriptionType ?? undefined,
      });
    } catch (error) {
      if (error instanceof TokenExchangeError) {
        // A different replica may have won while this request was in flight.
        // Re-enter credential authority before the source/route/file re-read,
        // so logout and route changes cannot be bypassed by adopting bytes from
        // the old home. Never clear/rewrite source or file for invalid_grant or
        // an ambiguous outcome.
        const adopted = await this.authority.runCredentialMutation(
          claudeCredentialMutationKey(this.config, input.tenantId, input.userId),
          async () => {
            if (!(await this.sourceIsStillManaged(input.tenantId, input.userId))) return null;
            const currentRoute = await this.route(input.tenantId, input.userId);
            if (join(currentRoute.claudeConfigDir, '.credentials.json') !== input.target)
              return null;
            const winner = await this.readCredential(input.target).catch(() => null);
            if (
              winner &&
              winner.raw !== observed.raw &&
              usableWithoutRefresh(winner.parsed, this.now())
            ) {
              return runtimeConnection(winner.parsed.claudeAiOauth.accessToken);
            }
            return null;
          }
        );
        if (adopted) return adopted;
        if (error.disposition === 'ambiguous') {
          throw new Unavailable('Claude login refresh is temporarily unavailable. Try again.');
        }
        throw new BadRequest('Claude could not refresh this login. Sign in again.');
      }
      throw error;
    }

    return this.authority.runCredentialMutation(
      claudeCredentialMutationKey(this.config, input.tenantId, input.userId),
      async (generation) => {
        if (!(await this.sourceIsStillManaged(input.tenantId, input.userId))) {
          throw new BadRequest('The Claude authentication method changed while the task started.');
        }
        const currentRoute = await this.route(input.tenantId, input.userId);
        const currentTarget = join(currentRoute.claudeConfigDir, '.credentials.json');
        if (currentTarget !== input.target) {
          throw new BadRequest('The Claude credential home changed while the task started.');
        }

        const nextContent = buildRefreshedCredential(observed.parsed, refreshed, this.now());
        const outcome = await this.compareAndSwap({
          target: input.target,
          expectedContent: observed.raw,
          content: nextContent,
          generation,
        });
        if (outcome.outcome === 'written') return runtimeConnection(refreshed.accessToken);

        // Login/logout/another refresh won the compare. Missing bytes are a
        // logout; changed usable bytes are the winner to adopt. Never recreate
        // the observed grant after losing this fence.
        if (outcome.content !== undefined) {
          const winner = parseCredential(outcome.content);
          if (winner && usableWithoutRefresh(winner, this.now())) {
            return runtimeConnection(winner.claudeAiOauth.accessToken);
          }
        }
        throw new BadRequest('The managed Claude login changed while the task started. Try again.');
      }
    );
  }
}
