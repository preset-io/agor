/** Durable, encrypted Dynamic Client Registration authority for PostgreSQL HA. */

import { createHmac, randomUUID } from 'node:crypto';
import {
  BOUND_SECRET_ENVELOPE_VERSION,
  generateId,
  type MCPOAuthClientRegistrationRecord,
  MCPOAuthClientRegistrationRepository,
  openBoundSecret,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  sealBoundSecret,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  DynamicClientRegistrationResponse,
  MCPOAuthDynamicClientRegistrationRequest,
} from '@agor/core/tools/mcp/oauth-mcp-transport';
import { OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type {
  MCPOAuthClientRegistrationID,
  MCPOAuthClientRegistrationSealedMaterial,
  MCPServerID,
} from '@agor/core/types';

const REGISTRATION_LEASE_MS = 30_000;
const REGISTRATION_WAIT_MS = 250;
const REGISTRATION_WAIT_LIMIT_MS = 70_000;

export interface DurableMCPOAuthClientRegistrationInput
  extends MCPOAuthDynamicClientRegistrationRequest {
  tenantId: string;
  mcpServerId: MCPServerID;
  serverConfigVersion: number;
}

function registrationBinding(material: {
  tenantId: string;
  registrationId: string;
  mcpServerId: string;
  registrationGeneration: number;
  bindingFingerprint: string;
}): string {
  return [
    material.tenantId,
    material.mcpServerId,
    material.registrationId,
    String(material.registrationGeneration),
    material.bindingFingerprint,
  ].join('\0');
}

function bindingFingerprint(
  masterSecret: string,
  input: DurableMCPOAuthClientRegistrationInput
): string {
  return createHmac('sha256', masterSecret)
    .update(
      JSON.stringify({
        version: 1,
        tenantId: input.tenantId,
        mcpServerId: input.mcpServerId,
        serverConfigVersion: input.serverConfigVersion,
        registrationEndpoint: input.registrationEndpoint,
        registrationEndpointSource: input.registrationEndpointSource,
        metadataUrl: input.metadataUrl,
        resourceUri: input.resourceUri,
        issuer: input.issuer,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        redirectUri: input.redirectUri,
        clientName: input.clientName,
        scope: input.scope ?? null,
        compatibilityMode: input.compatibilityMode,
        dcrMode: input.dcrMode,
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        requestedTokenEndpointAuthMethod: 'none',
      })
    )
    .digest('hex');
}

function isMaterial(value: unknown): value is MCPOAuthClientRegistrationSealedMaterial {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const material = value as Partial<MCPOAuthClientRegistrationSealedMaterial>;
  return (
    material.version === 1 &&
    typeof material.tenantId === 'string' &&
    typeof material.registrationId === 'string' &&
    typeof material.mcpServerId === 'string' &&
    Number.isSafeInteger(material.registrationGeneration) &&
    material.bindingVersion === 1 &&
    typeof material.bindingFingerprint === 'string' &&
    Number.isSafeInteger(material.serverConfigVersion) &&
    typeof material.registrationEndpoint === 'string' &&
    (material.registrationEndpointSource === 'metadata' ||
      material.registrationEndpointSource === 'legacy_fallback') &&
    typeof material.metadataUrl === 'string' &&
    typeof material.resourceUri === 'string' &&
    typeof material.issuer === 'string' &&
    typeof material.authorizationEndpoint === 'string' &&
    typeof material.tokenEndpoint === 'string' &&
    typeof material.redirectUri === 'string' &&
    (material.scope === undefined || typeof material.scope === 'string') &&
    (material.compatibilityMode === 'strict' ||
      material.compatibilityMode === 'legacy' ||
      material.compatibilityMode === 'marketplace') &&
    (material.dcrMode === 'disabled' ||
      material.dcrMode === 'advertised' ||
      material.dcrMode === 'fallback') &&
    typeof material.clientId === 'string' &&
    (material.clientSecret === undefined || typeof material.clientSecret === 'string') &&
    (material.clientSecretExpiresAt === undefined ||
      (Number.isSafeInteger(material.clientSecretExpiresAt) &&
        material.clientSecretExpiresAt! >= 0))
  );
}

function dcrFailureIsUnambiguous(error: unknown): boolean {
  return (
    error instanceof OAuthDCRFailure &&
    error.diagnostic.http_status !== undefined &&
    error.diagnostic.http_status >= 400 &&
    error.diagnostic.http_status < 500
  );
}

export class MCPOAuthClientRegistrationAuthority {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly masterSecret = process.env.AGOR_MASTER_SECRET
  ) {
    if (!masterSecret) {
      throw new Error('PostgreSQL MCP OAuth client registration requires AGOR_MASTER_SECRET');
    }
  }

  private open(
    record: MCPOAuthClientRegistrationRecord,
    expected: DurableMCPOAuthClientRegistrationInput
  ): DynamicClientRegistrationResponse {
    if (
      record.status !== 'registered' ||
      !record.isCurrent ||
      !record.sealedMaterial ||
      record.envelopeVersion !== BOUND_SECRET_ENVELOPE_VERSION
    ) {
      throw new Error('MCP OAuth client registration is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        openBoundSecret(
          record.sealedMaterial,
          this.masterSecret!,
          'dcr-client',
          registrationBinding(record)
        )
      );
    } catch {
      throw new Error('MCP OAuth client registration material is unavailable');
    }
    if (
      !isMaterial(parsed) ||
      parsed.tenantId !== record.tenantId ||
      parsed.registrationId !== record.registrationId ||
      parsed.mcpServerId !== record.mcpServerId ||
      parsed.registrationGeneration !== record.registrationGeneration ||
      parsed.bindingVersion !== record.bindingVersion ||
      parsed.bindingFingerprint !== record.bindingFingerprint ||
      parsed.serverConfigVersion !== record.serverConfigVersion ||
      record.bindingFingerprint !== bindingFingerprint(this.masterSecret!, expected) ||
      parsed.registrationEndpoint !== expected.registrationEndpoint ||
      parsed.registrationEndpointSource !== expected.registrationEndpointSource ||
      parsed.metadataUrl !== expected.metadataUrl ||
      parsed.resourceUri !== expected.resourceUri ||
      parsed.issuer !== expected.issuer ||
      parsed.authorizationEndpoint !== expected.authorizationEndpoint ||
      parsed.tokenEndpoint !== expected.tokenEndpoint ||
      parsed.redirectUri !== expected.redirectUri ||
      parsed.scope !== expected.scope ||
      parsed.compatibilityMode !== expected.compatibilityMode ||
      parsed.dcrMode !== expected.dcrMode ||
      (parsed.clientSecretExpiresAt === undefined
        ? record.clientSecretExpiresAt !== null
        : record.clientSecretExpiresAt?.getTime() !== parsed.clientSecretExpiresAt * 1000)
    ) {
      throw new Error('MCP OAuth client registration material binding is invalid');
    }
    return {
      client_id: parsed.clientId,
      ...(parsed.clientSecret ? { client_secret: parsed.clientSecret } : {}),
      redirect_uris: [parsed.redirectUri],
      token_endpoint_auth_method: parsed.clientSecret ? 'client_secret_basic' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(parsed.clientSecretExpiresAt !== undefined
        ? { client_secret_expires_at: parsed.clientSecretExpiresAt }
        : {}),
    };
  }

  async resolve(
    input: DurableMCPOAuthClientRegistrationInput,
    register: () => Promise<DynamicClientRegistrationResponse>,
    options: {
      assertCurrent?: () => void;
      assertServerCurrent?: () => Promise<void>;
    } = {}
  ): Promise<DynamicClientRegistrationResponse> {
    const fingerprint = bindingFingerprint(this.masterSecret!, input);
    const deadline = Date.now() + REGISTRATION_WAIT_LIMIT_MS;

    while (Date.now() < deadline) {
      options.assertCurrent?.();
      await options.assertServerCurrent?.();
      const claim = await runWithTenantDatabaseTransaction(this.db, input.tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).claimOrObserve({
          tenantId: input.tenantId,
          registrationId: generateId() as MCPOAuthClientRegistrationID,
          mcpServerId: input.mcpServerId,
          bindingFingerprint: fingerprint,
          serverConfigVersion: input.serverConfigVersion,
          envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
          claimId: randomUUID(),
          leaseMs: REGISTRATION_LEASE_MS,
        })
      );

      if (claim.outcome === 'ready') {
        options.assertCurrent?.();
        await options.assertServerCurrent?.();
        let registered: DynamicClientRegistrationResponse;
        try {
          registered = this.open(claim.registration, input);
        } catch (error) {
          await runWithTenantDatabaseScope(this.db, input.tenantId, (scoped) =>
            new MCPOAuthClientRegistrationRepository(scoped).invalidateRegistration(
              claim.registration
            )
          ).catch(() => undefined);
          throw error;
        }
        options.assertCurrent?.();
        await options.assertServerCurrent?.();
        return registered;
      }

      if (claim.outcome === 'waiting') {
        await new Promise((resolve) => setTimeout(resolve, REGISTRATION_WAIT_MS));
        continue;
      }

      const owned = claim.registration;
      let dispatched = false;
      try {
        options.assertCurrent?.();
        await options.assertServerCurrent?.();
        dispatched = await runWithTenantDatabaseScope(this.db, input.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).markDispatched(owned)
        );
        if (!dispatched) throw new Error('MCP OAuth client registration lease was lost');

        options.assertCurrent?.();
        await options.assertServerCurrent?.();
        const registered = await register();
        options.assertCurrent?.();
        await options.assertServerCurrent?.();

        const expiresAt = registered.client_secret_expires_at;
        const secretExpiresAt =
          expiresAt !== undefined && expiresAt > 0 ? new Date(expiresAt * 1000) : undefined;
        if (secretExpiresAt && !Number.isFinite(secretExpiresAt.getTime())) {
          throw new Error('Dynamic Client Registration returned an invalid client-secret expiry');
        }
        const material: MCPOAuthClientRegistrationSealedMaterial = {
          version: 1,
          tenantId: input.tenantId,
          registrationId: owned.registrationId,
          mcpServerId: input.mcpServerId,
          registrationGeneration: owned.registrationGeneration,
          bindingVersion: 1,
          bindingFingerprint: fingerprint,
          serverConfigVersion: input.serverConfigVersion,
          registrationEndpoint: input.registrationEndpoint,
          registrationEndpointSource: input.registrationEndpointSource,
          metadataUrl: input.metadataUrl,
          resourceUri: input.resourceUri,
          issuer: input.issuer,
          authorizationEndpoint: input.authorizationEndpoint,
          tokenEndpoint: input.tokenEndpoint,
          redirectUri: input.redirectUri,
          ...(input.scope ? { scope: input.scope } : {}),
          compatibilityMode: input.compatibilityMode,
          dcrMode: input.dcrMode,
          clientId: registered.client_id,
          ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
          ...(expiresAt !== undefined && expiresAt > 0 ? { clientSecretExpiresAt: expiresAt } : {}),
        };
        const sealed = sealBoundSecret(
          JSON.stringify(material),
          this.masterSecret!,
          'dcr-client',
          registrationBinding(material)
        );
        const persisted = await runWithTenantDatabaseScope(this.db, input.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).finishRegistered(
            owned,
            sealed,
            secretExpiresAt
          )
        );
        if (!persisted) {
          throw new Error('MCP OAuth client registration completion fence was lost');
        }
        return registered;
      } catch (error) {
        await runWithTenantDatabaseScope(this.db, input.tenantId, (scoped) =>
          new MCPOAuthClientRegistrationRepository(scoped).finishFailure(
            owned,
            dispatched && !dcrFailureIsUnambiguous(error) ? 'ambiguous' : 'failed',
            dispatched && !dcrFailureIsUnambiguous(error)
              ? 'registration_outcome_ambiguous'
              : 'registration_rejected'
          )
        ).catch(() => undefined);
        throw error;
      }
    }

    throw new Error('Timed out waiting for Dynamic Client Registration authority');
  }

  async invalidateForServer(tenantId: string, serverId: MCPServerID): Promise<number> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new MCPOAuthClientRegistrationRepository(scoped).invalidateForServer(tenantId, serverId)
    );
  }

  async maintain() {
    return runWithSystemDatabaseScope(
      this.db,
      'MCP OAuth client registration maintenance',
      (scoped) => new MCPOAuthClientRegistrationRepository(scoped).maintain(),
      { capability: 'mcp_oauth_client_registration_maintenance' }
    );
  }
}

export const __fingerprintMCPOAuthClientRegistrationForTests = bindingFingerprint;
