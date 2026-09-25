/** Daemon-only grant adapter. No helper executor, native home, or plaintext cache. */
import { isTenantAgenticToolEnabled, resolveProviderConnection } from '@agor/core/config';
import {
  assertTenantWritable,
  ClaudeOAuthAttemptRepository,
  type ProviderOAuthGrant,
  type ProviderOAuthTokenPair,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserProviderOAuthGrantRepository,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden, Unavailable } from '@agor/core/feathers';
import {
  ROTATING_GRANT_OBSERVE_INTERVAL_MS,
  ROTATING_GRANT_OBSERVE_TIMEOUT_MS,
  refreshRotatingGrant,
} from '@agor/core/oauth/rotating-grant-refresh';
import {
  type ClaudeOAuthCapability,
  hasMinimumRole,
  type ProviderOAuthRefreshFence,
  type UserID,
} from '@agor/core/types';
import {
  OutboundPreDispatchAuthorityError,
  safeOutboundFetch,
} from '@agor/core/utils/safe-outbound-fetch';
import { CLAUDE_CLIENT_ID, CLAUDE_OAUTH_BINDING, CLAUDE_TOKEN_URL } from './claude-oauth-policy.js';

const LAUNCH_MARGIN_MS = 60 * 60 * 1000;

class BackendRefreshFailure extends Error {
  constructor(
    readonly category: 'cancelled' | 'rejected' | 'invalid' | 'ambiguous',
    readonly retryMs = 0
  ) {
    super('Claude login refresh could not be completed. Reconnect in Settings.');
  }
}

export interface ClaudeBackendOAuthDependencies {
  request?: typeof safeOutboundFetch;
  now?: () => number;
  masterSecret?: string;
}

export class ClaudeBackendOAuth {
  private readonly request: typeof safeOutboundFetch;
  private readonly now: () => number;
  private readonly masterSecret: string;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    readonly capability: () => ClaudeOAuthCapability,
    dependencies: ClaudeBackendOAuthDependencies = {}
  ) {
    this.request = dependencies.request ?? safeOutboundFetch;
    this.now = dependencies.now ?? Date.now;
    this.masterSecret = dependencies.masterSecret ?? process.env.AGOR_MASTER_SECRET ?? '';
  }

  private unit<T>(tenantId: string, work: (db: TenantScopedDatabase) => Promise<T>) {
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  private writeUnit<T>(tenantId: string, work: (db: TenantScopedDatabase) => Promise<T>) {
    return this.unit(tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      return work(db);
    });
  }

  /** Also checked immediately before an already-claimed provider request. */
  async assertWritable(tenantId: string): Promise<void> {
    await this.writeUnit(tenantId, async () => {});
  }

  /** No role can borrow another user's private grant. Callers derive this ID from auth. */
  async authorize(tenantId: string, userId: UserID, selected = false): Promise<void> {
    const capability = this.capability();
    if (!capability.available || capability.storage !== 'backend') {
      throw new Unavailable('Claude sign-in is unavailable on this deployment.', {
        code: capability.reason,
      });
    }
    await this.unit(tenantId, async (db) => {
      const user = await new UsersRepository(db).findById(userId);
      if (!user || !hasMinimumRole(user.role, 'member') || !user.unix_username) {
        throw new Forbidden('Claude sign-in requires an active personal execution identity.');
      }
      if (!(await isTenantAgenticToolEnabled('claude-code', db))) {
        throw new Forbidden('Claude is disabled for this workspace.');
      }
      const connection = await resolveProviderConnection('claude-code', { userId, db });
      if (
        connection.policy === 'tenant_required' ||
        (selected && (connection.source !== 'user' || !connection.managedOAuth))
      ) {
        throw new Forbidden('Workspace policy or the personal credential selection changed.');
      }
    });
  }

  async save(
    tenantId: string,
    userId: UserID,
    generation: number,
    pair: ProviderOAuthTokenPair,
    attemptId: string
  ): Promise<void> {
    await this.writeUnit(tenantId, async (db) => {
      await new ClaudeOAuthAttemptRepository(db).lockUser(tenantId, userId);
      await new UsersRepository(db).getDiscoveryAuthorityProjectionForUpdate(userId);
      await this.authorize(tenantId, userId);
      await new UserProviderOAuthGrantRepository(db).replace(
        tenantId,
        userId,
        generation,
        CLAUDE_OAUTH_BINDING,
        pair,
        this.masterSecret,
        attemptId
      );
    });
  }

  async retire(tenantId: string, userId: UserID, generation: number): Promise<void> {
    await this.writeUnit(tenantId, (db) =>
      new UserProviderOAuthGrantRepository(db).retire(tenantId, userId, generation)
    );
  }

  async get(tenantId: string, userId: UserID): Promise<ProviderOAuthGrant | null> {
    return this.unit(tenantId, (db) =>
      new UserProviderOAuthGrantRepository(db).get(tenantId, userId)
    );
  }

  /** Inventory/status never decrypts or refreshes. Saved is not provider validation. */
  async status(
    tenantId: string,
    userId: UserID
  ): Promise<{ saved: boolean; usable: boolean; hint: string }> {
    const row = await this.get(tenantId, userId);
    if (!row || row.state === 'disconnected')
      return { saved: false, usable: false, hint: 'No saved Claude login. Sign in again.' };
    if (
      row.binding_version !== 1 ||
      row.binding_fingerprint !== CLAUDE_OAUTH_BINDING ||
      !row.sealed_access_token ||
      !row.sealed_refresh_token
    ) {
      return {
        saved: true,
        usable: false,
        hint: 'Saved Claude login is unavailable. Reconnect in Settings.',
      };
    }
    if (row.state === 'ambiguous' || row.state === 'reauth_required') {
      return {
        saved: true,
        usable: false,
        hint: 'Claude login needs reconnection. A previous refresh may have been consumed.',
      };
    }
    if (!row.expires_at || row.expires_at.getTime() <= this.now()) {
      return {
        saved: true,
        usable: false,
        hint: 'Saved Claude access token has expired. A new task can attempt a safe refresh.',
      };
    }
    return {
      saved: true,
      usable: true,
      hint: 'Claude login is saved with the backend; provider validation has not been performed.',
    };
  }

  /** Fixed endpoint, bounded response, pre-dispatch claim/actor recheck. */
  private async exchange(
    row: ProviderOAuthGrant,
    refreshToken: string,
    assertCurrent: () => Promise<void>
  ): Promise<ProviderOAuthTokenPair> {
    let response: Response;
    try {
      response = await this.request(CLAUDE_TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        timeoutMs: 15_000,
        maxResponseBytes: 64 * 1024,
        assertCurrent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          scope: row.scopes,
        }),
      });
    } catch (error) {
      throw new BackendRefreshFailure(
        error instanceof OutboundPreDispatchAuthorityError ? 'cancelled' : 'ambiguous'
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new BackendRefreshFailure('ambiguous');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BackendRefreshFailure('ambiguous');
    if (body.error !== undefined) {
      if (
        response.ok ||
        response.status >= 500 ||
        typeof body.error !== 'string' ||
        !body.error ||
        body.access_token !== undefined ||
        body.refresh_token !== undefined
      )
        throw new BackendRefreshFailure('ambiguous');
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(body.error))
        throw new BackendRefreshFailure('invalid');
      const retry = Number(response.headers.get('retry-after')) * 1000;
      throw new BackendRefreshFailure(
        'rejected',
        Math.min(300_000, Math.max(1000, Number.isFinite(retry) ? retry : 1000))
      );
    }
    if (
      !response.ok ||
      typeof body.access_token !== 'string' ||
      !body.access_token.trim() ||
      typeof body.expires_in !== 'number' ||
      !Number.isSafeInteger(body.expires_in) ||
      body.expires_in <= 0 ||
      body.expires_in > 400 * 24 * 60 * 60 ||
      (body.refresh_token !== undefined &&
        (typeof body.refresh_token !== 'string' || !body.refresh_token.trim())) ||
      (body.token_type !== undefined &&
        (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) ||
      (body.scope !== undefined && typeof body.scope !== 'string')
    )
      throw new BackendRefreshFailure('ambiguous');
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
      expiresAt: new Date(this.now() + body.expires_in * 1000),
      scopes: typeof body.scope === 'string' ? body.scope.split(' ') : row.scopes.split(' '),
      subscriptionType: row.subscription_type ?? undefined,
    };
  }

  async resolve(
    tenantId: string,
    userId: UserID,
    assertTask: () => Promise<void>
  ): Promise<{
    connection: { CLAUDE_CODE_OAUTH_TOKEN: string };
    useNativeAuth: false;
    credentialExpiresAt: string;
  }> {
    const authorize = async () => {
      await assertTask();
      await this.authorize(tenantId, userId, true);
    };
    await authorize();
    const initial = await this.get(tenantId, userId);
    if (initial?.binding_version !== 1 || initial.binding_fingerprint !== CLAUDE_OAUTH_BINDING) {
      throw new Unavailable('Saved Claude login is unavailable. Reconnect in Settings.');
    }
    const exact = (row: ProviderOAuthGrant | null): row is ProviderOAuthGrant =>
      !!row &&
      row.grant_generation === initial.grant_generation &&
      row.binding_fingerprint === initial.binding_fingerprint &&
      row.binding_version === 1;
    const deliver = async () => {
      await authorize();
      return this.unit(tenantId, async (db) => {
        const repository = new UserProviderOAuthGrantRepository(db);
        const row = await repository.get(tenantId, userId);
        if (
          !exact(row) ||
          row.state !== 'idle' ||
          !row.expires_at ||
          row.expires_at.getTime() < this.now() + LAUNCH_MARGIN_MS
        ) {
          throw new Unavailable('Claude token has insufficient lifetime or needs reconnection.', {
            code: 'insufficient_token_lifetime',
          });
        }
        const access = await repository.open(row, 'access-token', this.masterSecret);
        await authorize();
        const current = await repository.get(tenantId, userId);
        if (
          !exact(current) ||
          current.state !== 'idle' ||
          current.refresh_generation !== row.refresh_generation
        ) {
          throw new Forbidden('Claude credential changed before delivery. Start a new task.');
        }
        return {
          connection: { CLAUDE_CODE_OAUTH_TOKEN: access },
          useNativeAuth: false as const,
          credentialExpiresAt: row.expires_at.toISOString(),
        };
      });
    };
    if (
      initial.state === 'idle' &&
      initial.expires_at &&
      initial.expires_at.getTime() >= this.now() + LAUNCH_MARGIN_MS
    )
      return deliver();
    type Claim = { row: ProviderOAuthGrant; fence: ProviderOAuthRefreshFence };
    const observe = async (generation: number) => {
      const deadline = Date.now() + ROTATING_GRANT_OBSERVE_TIMEOUT_MS;
      do {
        await authorize();
        const row = await this.get(tenantId, userId);
        if (!exact(row))
          throw new Forbidden('Claude credential selection changed. Start a new task.');
        if (row.state === 'idle' && row.refresh_success_generation >= generation) return deliver();
        if (row.state !== 'refreshing')
          throw new Unavailable(
            'Claude refresh did not complete. Reconnect or try a new task later.'
          );
        await new Promise((resolve) => setTimeout(resolve, ROTATING_GRANT_OBSERVE_INTERVAL_MS));
      } while (Date.now() < deadline);
      throw new Unavailable(
        'Claude refresh is still unresolved. Reconnect if it does not complete.'
      );
    };
    const currentClaim = async ({ fence }: Claim) => {
      await this.assertWritable(tenantId);
      await authorize();
      const row = await this.get(tenantId, userId);
      if (
        !exact(row) ||
        row.state !== 'refreshing' ||
        row.refresh_claim_id !== fence.claimId ||
        row.refresh_generation !== fence.refreshGeneration
      ) {
        throw new Forbidden('Claude refresh authority changed.');
      }
    };
    return refreshRotatingGrant<Claim, ProviderOAuthTokenPair, Awaited<ReturnType<typeof deliver>>>(
      {
        claim: () =>
          this.writeUnit(tenantId, async (db) => {
            await new ClaudeOAuthAttemptRepository(db).lockUser(tenantId, userId);
            await authorize();
            const result = await new UserProviderOAuthGrantRepository(db).claim(tenantId, userId, {
              grantGeneration: initial.grant_generation,
              bindingFingerprint: initial.binding_fingerprint,
              refreshGeneration: initial.refresh_generation,
            });
            if (result.outcome === 'claimed') return { owned: true, claim: result };
            return {
              owned: false,
              observe: () =>
                observe(
                  Math.max(
                    initial.refresh_generation + (initial.state === 'idle' ? 1 : 0),
                    result.row?.refresh_generation ?? 0
                  )
                ),
            };
          }),
        prepare: currentClaim,
        exchange: async (claim) => {
          const refresh = await this.unit(tenantId, (db) =>
            new UserProviderOAuthGrantRepository(db).open(
              claim.row,
              'refresh-token',
              this.masterSecret
            )
          );
          return this.exchange(claim.row, refresh, () => currentClaim(claim));
        },
        commit: ({ fence }, pair) =>
          this.writeUnit(tenantId, async (db) => {
            await new ClaudeOAuthAttemptRepository(db).lockUser(tenantId, userId);
            await new UsersRepository(db).getDiscoveryAuthorityProjectionForUpdate(userId);
            // A stopped task loses delivery, not ownership of this user's received rotation.
            // Persist only under current personal source/policy/capability and exact claim.
            await this.authorize(tenantId, userId, true);
            return new UserProviderOAuthGrantRepository(db).complete(
              tenantId,
              userId,
              fence,
              pair,
              this.masterSecret
            );
          }),
        deliver,
        observe: ({ fence }) => observe(fence.refreshGeneration),
        recoverCommitted: async ({ fence }) => {
          const row = await this.get(tenantId, userId);
          return exact(row) &&
            row.state === 'idle' &&
            row.refresh_success_generation >= fence.refreshGeneration
            ? { value: await deliver() }
            : null;
        },
        classify: (error) =>
          error instanceof BackendRefreshFailure ? error.category : 'ambiguous',
        settle: ({ fence }, outcome, error) =>
          this.writeUnit(tenantId, async (db) => {
            await new UserProviderOAuthGrantRepository(db).finish(
              tenantId,
              userId,
              fence,
              outcome === 'invalid'
                ? 'reauth_required'
                : outcome === 'ambiguous'
                  ? 'ambiguous'
                  : 'idle',
              error instanceof BackendRefreshFailure ? error.retryMs : 0
            );
          }),
      }
    ).catch(() => {
      throw new Unavailable(
        'Claude login could not be refreshed safely. Reconnect in Settings or start a new task later.'
      );
    });
  }
}
