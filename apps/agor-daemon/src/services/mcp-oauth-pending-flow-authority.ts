/**
 * Durable MCP OAuth pending-flow authority for PostgreSQL deployments.
 *
 * PostgreSQL owns lifecycle and one-shot claims. This adapter owns the secret
 * boundary: it fingerprints raw OAuth state, seals/unseals PKCE and client
 * material with the deployment master secret, and verifies ciphertext binding
 * before any provider exchange. SQLite intentionally does not use this class.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  BOUND_SECRET_ENVELOPE_VERSION,
  generateId,
  type MCPOAuthPendingFlowClaimResult,
  type MCPOAuthPendingFlowRecord,
  MCPOAuthPendingFlowRepository,
  openBoundSecret,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  sealBoundSecret,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { OAuthFlowContext } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type {
  MCPOAuthAttemptID,
  MCPOAuthMode,
  MCPOAuthPendingFlowSealedMaterial,
  MCPServerID,
  UserID,
} from '@agor/core/types';
import { isMCPOAuthGrantBindingVersion } from '@agor/core/types';
import { grantBindingVersionForCompatibilityMode } from './mcp-oauth-grant-binding.js';

const FLOW_TTL_MS = 10 * 60 * 1000;

export type DurableMCPOAuthFlowContext = OAuthFlowContext;

export interface DurableMCPOAuthFlowCreate {
  context: DurableMCPOAuthFlowContext;
  tenantId: string;
  userId: UserID;
  mcpServerId: MCPServerID;
  oauthMode: MCPOAuthMode;
  configFingerprint: string;
}

export interface ClaimedDurableMCPOAuthFlow {
  record: MCPOAuthPendingFlowRecord;
  context: DurableMCPOAuthFlowContext;
}

export function fingerprintMCPOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function hasOnlyExpectedMaterialShape(value: unknown): value is MCPOAuthPendingFlowSealedMaterial {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<MCPOAuthPendingFlowSealedMaterial>;
  return (
    material.version === 2 &&
    typeof material.attemptId === 'string' &&
    typeof material.tenantId === 'string' &&
    typeof material.userId === 'string' &&
    typeof material.mcpServerId === 'string' &&
    (material.oauthMode === 'per_user' || material.oauthMode === 'shared') &&
    Number.isSafeInteger(material.grantGeneration) &&
    isMCPOAuthGrantBindingVersion(material.configFingerprintVersion) &&
    typeof material.configFingerprint === 'string' &&
    typeof material.resourceUri === 'string' &&
    typeof material.issuer === 'string' &&
    typeof material.authorizationEndpoint === 'string' &&
    typeof material.metadataUrl === 'string' &&
    typeof material.tokenEndpoint === 'string' &&
    typeof material.redirectUri === 'string' &&
    typeof material.pkceVerifier === 'string' &&
    typeof material.clientId === 'string' &&
    (material.clientSecret === undefined || typeof material.clientSecret === 'string') &&
    (material.clientRegistrationId === undefined ||
      typeof material.clientRegistrationId === 'string') &&
    (material.compatibilityMode === 'strict' ||
      material.compatibilityMode === 'legacy' ||
      material.compatibilityMode === 'marketplace') &&
    (material.authorizationResponseIssuerParameterSupported === undefined ||
      typeof material.authorizationResponseIssuerParameterSupported === 'boolean') &&
    typeof material.allowLocalhostHttp === 'boolean'
  );
}

function pendingEnvelopeBinding(input: {
  attemptId: string;
  tenantId: string;
  userId: string;
  mcpServerId: string;
  grantGeneration: number;
  configFingerprint: string;
}): string {
  return [
    input.tenantId,
    input.userId,
    input.mcpServerId,
    input.attemptId,
    String(input.grantGeneration),
    input.configFingerprint,
  ].join('\0');
}

export class MCPOAuthPendingFlowAuthority {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly masterSecret = process.env.AGOR_MASTER_SECRET
  ) {
    if (!masterSecret) {
      throw new Error(
        'PostgreSQL MCP OAuth pending flows require the deployment AGOR_MASTER_SECRET'
      );
    }
  }

  async create(input: DurableMCPOAuthFlowCreate): Promise<MCPOAuthAttemptID> {
    const attemptId = generateId() as MCPOAuthAttemptID;
    await runWithTenantDatabaseScope(this.db, input.tenantId, async (scoped) => {
      const repository = new MCPOAuthPendingFlowRepository(scoped);
      const subjectUserId = input.oauthMode === 'per_user' ? input.userId : null;
      // Allocation acquires the per-subject transaction lock first. The
      // tenant scope keeps that lock through sealing and create(), so a lower
      // generation can never insert after and supersede a higher generation.
      const grantGeneration = await repository.allocateGrantGeneration({
        tenantId: input.tenantId,
        mcpServerId: input.mcpServerId,
        oauthMode: input.oauthMode,
        subjectUserId,
      });
      const material: MCPOAuthPendingFlowSealedMaterial = {
        version: 2,
        attemptId,
        tenantId: input.tenantId,
        userId: input.userId,
        mcpServerId: input.mcpServerId,
        oauthMode: input.oauthMode,
        grantGeneration,
        configFingerprintVersion: grantBindingVersionForCompatibilityMode(
          input.context.compatibilityMode
        ),
        configFingerprint: input.configFingerprint,
        resourceUri: input.context.resourceUri,
        issuer: input.context.issuer,
        authorizationEndpoint: input.context.authorizationEndpoint,
        metadataUrl: input.context.metadataUrl,
        tokenEndpoint: input.context.tokenEndpoint,
        redirectUri: input.context.redirectUri,
        pkceVerifier: input.context.pkceVerifier,
        clientId: input.context.clientId,
        ...(input.context.clientSecret ? { clientSecret: input.context.clientSecret } : {}),
        ...(input.context.clientRegistrationId
          ? { clientRegistrationId: input.context.clientRegistrationId }
          : {}),
        compatibilityMode: input.context.compatibilityMode,
        authorizationResponseIssuerParameterSupported:
          input.context.authorizationResponseIssuerParameterSupported,
        allowLocalhostHttp: input.context.allowLocalhostHttp,
      };
      const sealedMaterial = sealBoundSecret(
        JSON.stringify(material),
        this.masterSecret!,
        'pending-exchange',
        pendingEnvelopeBinding({
          attemptId,
          tenantId: input.tenantId,
          userId: input.userId,
          mcpServerId: input.mcpServerId,
          grantGeneration,
          configFingerprint: input.configFingerprint,
        })
      );
      await repository.create({
        tenantId: input.tenantId,
        attemptId,
        stateHash: fingerprintMCPOAuthState(input.context.state),
        userId: input.userId,
        mcpServerId: input.mcpServerId,
        oauthMode: input.oauthMode,
        subjectUserId,
        grantGeneration,
        configFingerprintVersion: material.configFingerprintVersion,
        configFingerprint: input.configFingerprint,
        envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
        sealedMaterial,
        ttlMs: FLOW_TTL_MS,
      });
    });
    return attemptId;
  }

  async claimForCallback(rawState: string): Promise<MCPOAuthPendingFlowClaimResult> {
    const stateHash = fingerprintMCPOAuthState(rawState);
    return runWithSystemDatabaseScope(
      this.db,
      'MCP OAuth provider callback claim',
      (systemDb) =>
        new MCPOAuthPendingFlowRepository(systemDb).claimForCallback(stateHash, randomUUID()),
      { capability: 'mcp_oauth_callback' }
    );
  }

  async failPendingCallback(rawState: string, failureCode: string): Promise<boolean> {
    const stateHash = fingerprintMCPOAuthState(rawState);
    return runWithSystemDatabaseScope(
      this.db,
      'MCP OAuth provider callback authorization failure',
      (systemDb) =>
        new MCPOAuthPendingFlowRepository(systemDb).failPendingForCallback(stateHash, failureCode),
      { capability: 'mcp_oauth_callback' }
    );
  }

  async claimForUser(
    tenantId: string,
    userId: UserID,
    rawState: string
  ): Promise<MCPOAuthPendingFlowClaimResult> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new MCPOAuthPendingFlowRepository(scoped).claimForUser(
        tenantId,
        userId,
        fingerprintMCPOAuthState(rawState),
        randomUUID()
      )
    );
  }

  openClaim(record: MCPOAuthPendingFlowRecord, rawState: string): ClaimedDurableMCPOAuthFlow {
    if (
      record.status !== 'exchanging' ||
      !record.exchangeClaimId ||
      !record.sealedMaterial ||
      record.stateHash !== fingerprintMCPOAuthState(rawState)
    ) {
      throw new Error('MCP OAuth pending-flow claim is incomplete');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        openBoundSecret(
          record.sealedMaterial,
          this.masterSecret!,
          'pending-exchange',
          pendingEnvelopeBinding({
            attemptId: record.attemptId,
            tenantId: record.tenantId,
            userId: record.userId,
            mcpServerId: record.mcpServerId,
            grantGeneration: record.grantGeneration,
            configFingerprint: record.configFingerprint,
          })
        )
      );
    } catch {
      throw new Error('MCP OAuth pending-flow material is unavailable');
    }
    if (!hasOnlyExpectedMaterialShape(parsed)) {
      throw new Error('MCP OAuth pending-flow material is invalid');
    }
    const material = parsed;
    if (
      material.attemptId !== record.attemptId ||
      material.tenantId !== record.tenantId ||
      material.userId !== record.userId ||
      material.mcpServerId !== record.mcpServerId ||
      material.oauthMode !== record.oauthMode ||
      material.grantGeneration !== record.grantGeneration ||
      material.configFingerprintVersion !== record.configFingerprintVersion ||
      material.configFingerprint !== record.configFingerprint ||
      record.envelopeVersion !== BOUND_SECRET_ENVELOPE_VERSION ||
      !record.isCurrent
    ) {
      throw new Error('MCP OAuth pending-flow material binding is invalid');
    }

    return {
      record,
      context: {
        metadataUrl: material.metadataUrl,
        resourceUri: material.resourceUri,
        issuer: material.issuer,
        authorizationEndpoint: material.authorizationEndpoint,
        tokenEndpoint: material.tokenEndpoint,
        redirectUri: material.redirectUri,
        pkceVerifier: material.pkceVerifier,
        clientId: material.clientId,
        clientSecret: material.clientSecret,
        clientRegistrationId: material.clientRegistrationId,
        state: rawState,
        // Completion never reads this field. Do not persist or reconstruct the
        // secret-bearing authorization URL after the browser has opened it.
        authorizationUrl: '',
        compatibilityMode: material.compatibilityMode,
        // Older version-2 envelopes predate this explicit bit. Strict starts
        // could only succeed when the AS advertised RFC 9207, while legacy
        // never required it, so the mode reconstructs the old contract.
        authorizationResponseIssuerParameterSupported:
          material.authorizationResponseIssuerParameterSupported ??
          material.compatibilityMode === 'strict',
        allowLocalhostHttp: material.allowLocalhostHttp,
      },
    };
  }

  async getForUser(tenantId: string, userId: UserID, attemptId: MCPOAuthAttemptID) {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new MCPOAuthPendingFlowRepository(scoped).getForUser(tenantId, userId, attemptId)
    );
  }

  async finish(
    record: MCPOAuthPendingFlowRecord,
    status: 'succeeded' | 'failed' | 'ambiguous',
    failureCode?: string
  ): Promise<boolean> {
    if (!record.exchangeClaimId) return false;
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new MCPOAuthPendingFlowRepository(scoped).finish(
        record.tenantId,
        record.attemptId,
        record.exchangeClaimId!,
        status,
        failureCode
      )
    );
  }

  async maintain() {
    return runWithSystemDatabaseScope(
      this.db,
      'MCP OAuth pending-flow maintenance',
      (systemDb) => new MCPOAuthPendingFlowRepository(systemDb).maintain(),
      { capability: 'mcp_oauth_maintenance' }
    );
  }

  async invalidateForServer(tenantId: string, serverId: MCPServerID): Promise<number> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new MCPOAuthPendingFlowRepository(scoped).invalidateForServer(tenantId, serverId)
    );
  }
}
