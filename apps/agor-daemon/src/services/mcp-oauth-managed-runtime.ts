/** Cell adapter: owns no provider clients, endpoints, refresh state machine or token cache. */
import { createHash, type KeyObject, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateId,
  getMCPEgressGatewayMode,
  MCPManagedOAuthOutboxRepository,
  type MCPOAuthPendingFlowRecord,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import {
  executeManagedOAuthOperation,
  type ManagedMCPOAuthClient,
  ManagedMCPOAuthOperationError,
  recoverManagedOAuthOperation,
} from '@agor/core/tools/mcp/managed-oauth-client';
import {
  type MCPManagedOAuthResolvedProfile,
  type MCPManagedOAuthReturnResult,
  type MCPManagedOAuthStartResult,
  type MCPManagedOAuthTokenCommit,
  type MCPOAuthAttemptID,
  type MCPServer,
  type MCPServerID,
  McpOAuthActivateResponseSchema,
  McpOAuthAuthorityRequestSchema,
  McpOAuthAuthorityResponseSchema,
  type McpOAuthOwner,
  McpOAuthPrepareResponseSchema,
  McpOAuthReturnTicketRequestSchema,
  McpOAuthTransactionRequestSchema,
  McpOAuthTransactionStatusSchema,
  mcpOAuthOwnerBytes,
  mcpOAuthSha256,
  type UserID,
} from '@agor/core/types';
import { isCurrentManagedCatalogInstall } from './mcp-catalog-install-policy.js';
import {
  fingerprintManagedMCPOAuthGrantConfiguration,
  lockMCPOAuthGrantConfiguration,
} from './mcp-oauth-grant-binding.js';
import {
  assertManagedOAuthLocalOwner,
  type ManagedOAuthLocalIdentityPolicy,
  resolveManagedOAuthLocalSubject,
} from './mcp-oauth-managed-authority.js';
import { ManagedOAuthUnavailableError } from './mcp-oauth-managed-errors.js';
import type { MCPOAuthPendingFlowAuthority } from './mcp-oauth-pending-flow-authority.js';

export { ManagedOAuthUnavailableError } from './mcp-oauth-managed-errors.js';

export interface ManagedOAuthRuntimeDependencies {
  db: TenantScopeAwareDatabase;
  flows: MCPOAuthPendingFlowAuthority;
  client: ManagedMCPOAuthClient;
  masterSecret: string;
  identity: ManagedOAuthLocalIdentityPolicy;
  issuer: string;
  keys: ReadonlyMap<string, KeyObject>;
  /** Independent bounded-error deployment clock. Unknown or unsafe throws. */
  now: () => number;
  /** Fresh authenticated profile/cohort/recovery capability evidence; never row-only trust. */
  resolveProfile: (
    server: MCPServer,
    operation: 'new_starts' | 'exchange' | 'refresh' | 'use'
  ) => Promise<MCPManagedOAuthResolvedProfile>;
  /** Existing persistence adapter commits receipt, token, permit and pending completion atomically. */
  persist: (input: {
    record: MCPOAuthPendingFlowRecord;
    profile: MCPManagedOAuthResolvedProfile;
    commit: MCPManagedOAuthTokenCommit;
  }) => Promise<void>;
  /** ACK is best-effort only AFTER the local transaction committed. */
  acknowledge: (
    commit: MCPManagedOAuthTokenCommit,
    execution?: { timeoutMs?: number; assertCurrent?: () => void | Promise<void> }
  ) => Promise<void>;
}

function equalOwner(left: McpOAuthOwner, right: McpOAuthOwner): boolean {
  return Buffer.from(mcpOAuthOwnerBytes(left)).equals(Buffer.from(mcpOAuthOwnerBytes(right)));
}
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class ManagedMCPOAuthRuntime {
  constructor(readonly dependencies: ManagedOAuthRuntimeDependencies) {}

  private async server(
    tenantId: string,
    userId: UserID,
    serverId: MCPServerID
  ): Promise<MCPServer> {
    return runWithTenantDatabaseScope(this.dependencies.db, tenantId, async (db) => {
      const server = await new MCPServerRepository(db).findById(serverId);
      if (
        (await getMCPEgressGatewayMode(db)) !== 'enforced' ||
        !server ||
        server.owner_user_id !== userId ||
        !server.enabled ||
        server.auth?.oauth_client_mode !== 'cloud_managed_v1'
      )
        throw new ManagedOAuthUnavailableError();
      return server;
    });
  }

  async current(
    owner: McpOAuthOwner,
    operation: 'new_starts' | 'exchange' | 'refresh' | 'use'
  ): Promise<MCPManagedOAuthResolvedProfile> {
    const d = this.dependencies;
    const server = await this.server(
      owner.workspace_id,
      owner.cell_local_user_id as UserID,
      owner.server_id as MCPServerID
    );
    const profile = await d.resolveProfile(server, operation);
    const entry = findCatalogEntry(await loadCatalog(), profile.catalogEntryName);
    if (
      !entry?.remote_url ||
      !isCurrentManagedCatalogInstall(
        server,
        { ...entry, remote_url: entry.remote_url },
        profile.reference,
        owner.cell_local_user_id as UserID
      )
    )
      throw new ManagedOAuthUnavailableError();
    await runWithTenantDatabaseScope(d.db, owner.workspace_id, async (db) => {
      await lockMCPOAuthGrantConfiguration(db, owner.workspace_id, server.mcp_server_id);
      const fresh = await new MCPServerRepository(db).findById(server.mcp_server_id);
      if (
        (await getMCPEgressGatewayMode(db)) !== 'enforced' ||
        !fresh ||
        fresh.owner_user_id !== owner.cell_local_user_id
      )
        throw new ManagedOAuthUnavailableError();
      await assertManagedOAuthLocalOwner(
        db,
        owner.workspace_id,
        owner.cell_local_user_id as UserID,
        d.identity,
        owner
      );
      const fingerprint = fingerprintManagedMCPOAuthGrantConfiguration(
        d.masterSecret,
        fresh,
        profile,
        {
          tenantId: owner.workspace_id,
          userId: owner.cell_local_user_id,
          cloudSubject: owner.cloud_user_subject,
          grantGeneration: owner.grant_generation,
        }
      );
      if (!sameDigest(fingerprint, owner.config_fingerprint))
        throw new ManagedOAuthUnavailableError();
    });
    d.now();
    return profile;
  }

  /** No provider discovery/DCR; reserve local authority before broker/browser activation. */
  async start(input: {
    tenantId: string;
    userId: UserID;
    serverId: MCPServerID;
    clientNonce: string;
    assertCurrent: () => void | Promise<void>;
  }): Promise<MCPManagedOAuthStartResult> {
    const d = this.dependencies;
    if (!/^[a-f0-9-]{36}$/i.test(input.clientNonce)) throw new ManagedOAuthUnavailableError();
    await input.assertCurrent();
    const server = await this.server(input.tenantId, input.userId, input.serverId);
    const profile = await d.resolveProfile(server, 'new_starts');
    const subject = await resolveManagedOAuthLocalSubject(
      d.db,
      input.tenantId,
      input.userId,
      d.identity
    );
    const attemptId = generateId() as MCPOAuthAttemptID;
    const generation = await d.flows.reserveManagedAttempt({
      tenantId: input.tenantId,
      userId: input.userId,
      mcpServerId: input.serverId,
    });
    const fingerprint = fingerprintManagedMCPOAuthGrantConfiguration(
      d.masterSecret,
      server,
      profile,
      {
        tenantId: input.tenantId,
        userId: input.userId,
        cloudSubject: subject,
        grantGeneration: String(generation),
      }
    );
    const selectors = McpOAuthAuthorityRequestSchema.parse({
      protocol_version: 1,
      operation_id: randomUUID(),
      workspace_id: input.tenantId,
      cloud_user_subject: subject,
      cell_local_user_id: input.userId,
      server_id: input.serverId,
      attempt_id: attemptId,
      profile_id: profile.reference.profile_id,
      profile_version: profile.reference.semantic_version,
      catalog_digest: profile.reference.registry_digest,
      config_fingerprint: fingerprint,
      grant_generation: String(generation),
    });
    const authority = await d.client.request({
      operation: 'authority',
      body: selectors,
      schema: McpOAuthAuthorityResponseSchema,
      assertCurrent: input.assertCurrent,
    });
    const owner = authority.owner;
    // Cloud may fill epochs/placement, but cannot change any local selector.
    for (const key of [
      'workspace_id',
      'cloud_user_subject',
      'cell_local_user_id',
      'server_id',
      'attempt_id',
      'profile_id',
      'profile_version',
      'catalog_digest',
      'config_fingerprint',
      'grant_generation',
    ] as const) {
      if (owner[key] !== selectors[key]) throw new ManagedOAuthUnavailableError();
    }
    const verifier = randomBytes(32).toString('base64url');
    const replacement = await runWithTenantDatabaseScope(d.db, input.tenantId, async (db) => {
      await lockMCPOAuthGrantConfiguration(db, input.tenantId, input.serverId);
      const fresh = await new MCPServerRepository(db).findById(input.serverId);
      if (!fresh || fresh.owner_user_id !== input.userId) throw new ManagedOAuthUnavailableError();
      await assertManagedOAuthLocalOwner(db, input.tenantId, input.userId, d.identity, owner);
      const fingerprintForGeneration = (grantGeneration: string) =>
        fingerprintManagedMCPOAuthGrantConfiguration(d.masterSecret, fresh, profile, {
          tenantId: input.tenantId,
          userId: input.userId,
          cloudSubject: subject,
          grantGeneration,
        });
      if (!sameDigest(fingerprintForGeneration(owner.grant_generation), owner.config_fingerprint))
        throw new ManagedOAuthUnavailableError();
      const prior =
        (await new UserMCPOAuthTokenRepository(db).getManagedMetadata(
          input.userId,
          input.serverId
        )) ??
        (await new MCPManagedOAuthOutboxRepository(db).getRetiredGrantForReplacement(
          owner,
          d.identity,
          fingerprintForGeneration
        ));
      if (!prior) return null;
      // This is only a nonsecret account-continuity selector, not authority to
      // reopen the old grant. The broker still admits explicit fresh consent.
      if (
        BigInt(prior.owner.grant_generation) >= BigInt(owner.grant_generation) ||
        !sameDigest(
          fingerprintForGeneration(prior.owner.grant_generation),
          prior.owner.config_fingerprint
        ) ||
        !equalOwner(
          {
            ...prior.owner,
            attempt_id: owner.attempt_id,
            grant_generation: owner.grant_generation,
            config_fingerprint: owner.config_fingerprint,
          },
          owner
        )
      )
        throw new ManagedOAuthUnavailableError();
      return prior.handle;
    });
    const prepare = {
      protocol_version: 1 as const,
      operation_id: randomUUID(),
      owner,
      catalog_entry_name: profile.catalogEntryName,
      pkce_challenge: createHash('sha256').update(verifier).digest('base64url'),
      method: 'S256' as const,
      client_nonce_hash: mcpOAuthSha256(input.clientNonce),
      replacement_handle: replacement,
    };
    await this.current(owner, 'new_starts');
    const record = await d.flows.reserveManaged({
      tenantId: input.tenantId,
      userId: input.userId,
      mcpServerId: input.serverId,
      attemptId,
      grantGeneration: generation,
      build: () => ({ owner, prepare_request: prepare, pkce_verifier: verifier }),
    });
    const assertPending = async () => {
      await input.assertCurrent();
      await this.current(owner, 'new_starts');
      const fresh = await d.flows.getForUser(input.tenantId, input.userId, attemptId);
      if (
        !fresh?.isCurrent ||
        fresh.status !== 'pending' ||
        fresh.expiresAt.getTime() <= d.now() ||
        !fresh.managedMetadata ||
        !equalOwner(fresh.managedMetadata.owner, owner)
      )
        throw new ManagedOAuthUnavailableError();
    };
    try {
      // If prepare response is lost the saved operation remains recoverable by the cancellation outbox; never invent a new prepare identity.
      const prepared = await d.client.request({
        operation: 'prepare',
        body: prepare,
        schema: McpOAuthPrepareResponseSchema,
        assertCurrent: assertPending,
      });
      if (
        prepared.expires_at <= d.now() ||
        !(await d.flows.bindManagedTransaction(
          record,
          prepared.transaction_id,
          prepared.cancel_epoch
        ))
      )
        throw new ManagedOAuthUnavailableError();
      const activate = McpOAuthTransactionRequestSchema.parse({
        protocol_version: 1,
        operation_id: randomUUID(),
        owner,
        transaction_id: prepared.transaction_id,
      });
      const active = await d.client.request({
        operation: 'activate',
        id: prepared.transaction_id,
        body: activate,
        schema: McpOAuthActivateResponseSchema,
        assertCurrent: assertPending,
      });
      if (active.transaction_id !== prepared.transaction_id || active.expires_at <= d.now())
        throw new ManagedOAuthUnavailableError();
      await assertPending();
      return {
        success: true,
        oauth_client_mode: 'cloud_managed_v1',
        authorizationUrl: active.intent_url,
        attempt_id: attemptId,
        transaction_id: prepared.transaction_id,
      };
    } catch (error) {
      // Exact old attempt only: a failed start must not cancel a concurrent newer reconnect.
      await d.flows.retireManagedAttempt(record, 'managed_start_failed').catch(() => undefined);
      throw error;
    }
  }

  /** Browser navigation correlation only. The authenticated worker remains the ticket authority. */
  async acceptReturn(input: {
    tenantId: string;
    userId: UserID;
    transactionId: string;
    ticket: string;
    clientNonce: string;
    requestOrigin: string;
    assertCurrent: () => void | Promise<void>;
  }): Promise<MCPManagedOAuthReturnResult> {
    const d = this.dependencies;
    await input.assertCurrent();
    if (!/^[a-f0-9-]{36}$/i.test(input.clientNonce)) throw new ManagedOAuthUnavailableError();
    const record = await d.flows.getManagedForTransaction(
      input.tenantId,
      input.userId,
      input.transactionId
    );
    if (
      !record?.managedMetadata ||
      !record.isCurrent ||
      !sameDigest(
        record.managedMetadata.prepare_request.client_nonce_hash,
        mcpOAuthSha256(input.clientNonce)
      )
    )
      throw new ManagedOAuthUnavailableError();
    const owner = record.managedMetadata.owner;
    const assertCurrent = async () => {
      await input.assertCurrent();
      await runWithTenantDatabaseTransaction(
        d.db,
        input.tenantId,
        async () => {
          // Join one local snapshot: the repository permits succeeded routing only
          // with the exact still-current original grant. No credential is decrypted.
          const current = await d.flows.getManagedForTransaction(
            input.tenantId,
            input.userId,
            input.transactionId
          );
          if (
            !current?.isCurrent ||
            !current.managedMetadata ||
            !equalOwner(current.managedMetadata.owner, owner) ||
            current.attemptId !== record.attemptId ||
            current.managedTransactionId !== input.transactionId ||
            !sameDigest(
              current.managedMetadata.prepare_request.client_nonce_hash,
              mcpOAuthSha256(input.clientNonce)
            ) ||
            current.expiresAt.getTime() <= d.now()
          )
            throw new ManagedOAuthUnavailableError();
          await this.current(owner, current.status === 'succeeded' ? 'use' : 'exchange');
        },
        { postgresIsolationLevel: 'repeatable read' }
      );
      await input.assertCurrent();
    };
    const request = McpOAuthReturnTicketRequestSchema.parse({
      protocol_version: 1,
      operation_id: randomUUID(),
      owner,
      ticket: input.ticket,
      client_nonce_hash: mcpOAuthSha256(input.clientNonce),
      request_origin: input.requestOrigin,
    });
    const evidence = await d.client.request({
      operation: 'return_ticket',
      body: request,
      schema: McpOAuthTransactionStatusSchema.pick({
        protocol_version: true,
        transaction_id: true,
        owner: true,
      }),
      assertCurrent,
    });
    if (!equalOwner(evidence.owner, owner) || evidence.transaction_id !== input.transactionId)
      throw new ManagedOAuthUnavailableError();
    await assertCurrent();
    return { accepted: true, attempt_id: record.attemptId };
  }

  /** Status evidence may trigger completion; a browser ticket or postMessage never does. */
  async reconcile(
    record: MCPOAuthPendingFlowRecord,
    execution: {
      timeoutMs?: number;
      assertCurrent?: () => void | Promise<void>;
    } = {}
  ): Promise<void> {
    if (
      execution.timeoutMs !== undefined &&
      (!Number.isFinite(execution.timeoutMs) || execution.timeoutMs <= 0)
    )
      throw new ManagedOAuthUnavailableError();
    // Public attempt-status callers omit a budget. Bound their actual broker
    // transport work, not merely the HTTP response: a timed-out dispatch keeps
    // its original durable claim and subsequent polls recover that receipt.
    // Maintenance supplies its own enclosing pass budget explicitly.
    const deadline = performance.now() + (execution.timeoutMs ?? 5_000);
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const assertBudget = async () => {
      await execution.assertCurrent?.();
      if (performance.now() >= deadline) throw new ManagedOAuthUnavailableError();
    };
    await assertBudget();
    if (
      record.credentialOrigin !== 'cloud_managed_v1' ||
      !record.isCurrent ||
      !record.managedMetadata ||
      !record.managedTransactionId ||
      !['pending', 'exchanging'].includes(record.status)
    )
      return;
    const d = this.dependencies;
    const owner = record.managedMetadata.owner;
    const profile = await this.current(owner, 'exchange');
    let activeClaim = record.status === 'exchanging' ? record : undefined;
    const assertCurrent = async () => {
      await assertBudget();
      await this.current(owner, 'exchange');
      const fresh = await d.flows.getForUser(record.tenantId, record.userId, record.attemptId);
      if (
        !fresh?.isCurrent ||
        !fresh.managedMetadata ||
        !equalOwner(owner, fresh.managedMetadata.owner) ||
        fresh.managedTransactionId !== record.managedTransactionId ||
        fresh.expiresAt.getTime() <= d.now() ||
        !['pending', 'exchanging'].includes(fresh.status) ||
        (activeClaim !== undefined &&
          (fresh.status !== 'exchanging' ||
            fresh.exchangeClaimId !== activeClaim.exchangeClaimId ||
            fresh.managedOperationId !== activeClaim.managedOperationId))
      )
        throw new ManagedOAuthUnavailableError();
    };
    let claimed = record;
    const recovering = record.status === 'exchanging';
    if (!recovering) {
      const status = await d.client.request({
        operation: 'status',
        id: record.managedTransactionId,
        body: {
          protocol_version: 1,
          operation_id: randomUUID(),
          owner,
          transaction_id: record.managedTransactionId,
        },
        schema: McpOAuthTransactionStatusSchema,
        timeoutMs: remaining(),
        assertCurrent,
      });
      if (['expired', 'failed', 'canceled'].includes(status.status)) {
        if (
          !equalOwner(status.owner, owner) ||
          status.transaction_id !== record.managedTransactionId
        )
          throw new ManagedOAuthUnavailableError();
        await d.flows.retireManagedAttempt(record, 'managed_broker_terminal');
        return;
      }
      if (status.status !== 'callback_ready') return;
      const result = await d.flows.claimManagedForTenant(record, status);
      if (result.outcome !== 'claimed') return;
      claimed = result.flow;
      activeClaim = claimed;
    }
    const material = d.flows.openManagedClaim(claimed);
    const request = {
      protocol_version: 1 as const,
      operation_id: material.operation_id,
      owner,
      transaction_id: record.managedTransactionId,
      claim: material.claim,
      cancel_epoch: record.managedMetadata.cancel_epoch,
      pkce_verifier: material.pkce_verifier,
    };
    try {
      const verified = recovering
        ? await recoverManagedOAuthOperation({
            client: d.client,
            expected: {
              owner,
              claim: material.claim,
              operationId: material.operation_id,
              sequence: '0',
            },
            issuer: d.issuer,
            keys: d.keys,
            now: d.now,
            assertCurrent,
            timeoutMs: remaining(),
          })
        : await executeManagedOAuthOperation({
            client: d.client,
            request,
            sequence: '0',
            issuer: d.issuer,
            keys: d.keys,
            now: d.now,
            assertCurrent,
            timeoutMs: remaining(),
          });
      await assertCurrent();
      const r = verified.result;
      const commit: MCPManagedOAuthTokenCommit = {
        tokens: r.tokens,
        expected_sequence: '0',
        operation_id: r.operation_id,
        metadata: {
          owner,
          transaction_id: record.managedTransactionId,
          handle: r.handle,
          handle_epoch: r.handle_epoch,
          next_sequence: r.next_sequence,
          operation_id: r.operation_id,
          receipt_id: r.receipt_id,
          claim: material.claim,
          signed_receipt: r.signed_receipt,
          receipt_claims: verified.receipt,
          use_authorization: r.use_authorization,
          use_claims: verified.use,
        },
      };
      await d.persist({ record: claimed, profile, commit });
      // Lost ACK is never permission to revoke a committed grant or replay exchange.
      await assertBudget()
        .then(() => d.acknowledge(commit, { timeoutMs: remaining(), assertCurrent: assertBudget }))
        .catch(() => undefined);
    } catch (error) {
      if (error instanceof ManagedMCPOAuthOperationError) {
        const ambiguous = ['ambiguous', 'expired', 'acknowledged'].includes(error.outcome.status);
        await d.flows.finish(
          claimed,
          ambiguous ? 'ambiguous' : 'failed',
          error.outcome.failure_code
        );
      }
      // Transport uncertainty leaves the original claim available ONLY for receipt recovery until its hard deadline.
      throw error;
    }
  }
}
