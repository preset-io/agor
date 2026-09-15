/** Authenticated nonsecret worker registry. No URLs/client overrides come from a caller. */
import { randomUUID } from 'node:crypto';
import type { AgorManagedMCPOAuthSettings } from '@agor/core/config';
import { findCatalogEntry } from '@agor/core/mcp-catalog';
import {
  type MCPCatalogEntry,
  type MCPManagedOAuthResolvedProfile,
  type MCPServer,
  McpOAuthCapabilitiesSchema,
  McpOAuthCapabilityRequestSchema,
  type McpOAuthProfileProjectionSchema,
} from '@agor/core/types';
import type { ManagedOAuthDeployment } from '../mcp-egress/managed-deployment.js';
import { ManagedOAuthUnavailableError } from './mcp-oauth-managed-runtime.js';

type Operation = 'new_starts' | 'exchange' | 'refresh' | 'use';
type Capabilities = ReturnType<typeof McpOAuthCapabilitiesSchema.parse>;
type Projection = ReturnType<typeof McpOAuthProfileProjectionSchema.parse>;
const SNAPSHOT_MAX_MS = 120_000;

export const MANAGED_OAUTH_DISCLOSURE =
  'Agor Cloud handles this provider sign-in through a shared callback and token broker. Your workspace stores your grant. The broker temporarily processes authorization codes and tokens; it does not provide a central token vault. Disconnect blocks new workspace use immediately; provider revocation may remain pending. Direct sign-in remains a separate option.';

function project(value: Projection): MCPManagedOAuthResolvedProfile {
  return {
    reference: {
      profile_id: value.profile_id,
      semantic_version: value.profile_version,
      environment: value.environment,
      region: value.region,
      registry_digest: value.catalog_digest,
    },
    catalogEntryName: value.catalog_entry_name,
    mcpUrl: value.exact_resource_uri,
    transport: 'http',
    metadataEndpoints: [...value.metadata_endpoints],
    metadataUri: value.metadata_endpoints.length === 1 ? value.metadata_endpoints[0]! : '',
    resourceUri: value.exact_resource_uri,
    issuer: value.issuer,
    authorizationEndpoint: value.authorization_endpoint,
    tokenEndpoint: value.token_endpoint,
    redirectUri: value.exact_redirect_uri,
    clientId: value.client_id,
    scope: value.scope.join(' '),
    tokenEndpointAuthMethod: value.token_endpoint_auth_method,
    clientKind: value.client_kind,
    registrationProvenanceDigest: value.registration_evidence_digest,
  };
}

export class ManagedOAuthRegistry {
  private snapshot?: { value: Capabilities; observedAt: number };
  private refreshInFlight?: Promise<void>;
  private readonly settings: Readonly<AgorManagedMCPOAuthSettings>;
  constructor(
    settings: AgorManagedMCPOAuthSettings,
    private readonly deployment: ManagedOAuthDeployment,
    private readonly catalog: readonly MCPCatalogEntry[]
  ) {
    this.settings = Object.freeze({ ...settings });
  }

  /** Periodic/bootstrap I/O only. Never invoke from a tenant authority transaction. */
  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const work = async () => {
      const observedAt = this.deployment.clock.latestUtcMs();
      const value = await this.deployment.sender.request({
        operation: 'capabilities',
        body: McpOAuthCapabilityRequestSchema.parse({
          protocol_version: 1,
          operation_id: randomUUID(),
        }),
        schema: McpOAuthCapabilitiesSchema,
        recovery: true,
        assertCurrent: () => {
          this.deployment.getEvidence();
        },
      });
      // A failed refresh never replaces known state with an empty/allowing projection.
      this.snapshot = { value, observedAt };
      // Authenticated negative evidence takes effect immediately, even if refresh reports unavailable.
      this.assertSnapshot(value);
    };
    this.refreshInFlight = work();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private assertSnapshot(value: Capabilities): void {
    const evidence = this.deployment.getEvidence();
    if (
      !value.available ||
      !value.flags.managed_mcp_oauth_v1 ||
      value.environment !== this.settings.environment ||
      value.residency_region !== this.settings.region ||
      value.recovery_incarnation !== evidence.recovery_incarnation
    )
      throw new ManagedOAuthUnavailableError();
    const identities = value.profile_versions.map((p) => `${p.profile_id}\0${p.profile_version}`);
    if (new Set(identities).size !== identities.length) throw new ManagedOAuthUnavailableError();
  }

  /** Synchronous, bounded freshness; no network or token cache. */
  capabilities(): Capabilities {
    const snapshot = this.snapshot;
    const now = this.deployment.clock.latestUtcMs();
    if (!snapshot || now < snapshot.observedAt || now - snapshot.observedAt >= SNAPSHOT_MAX_MS)
      throw new ManagedOAuthUnavailableError();
    this.assertSnapshot(snapshot.value);
    // Consumers cannot mutate the root-owned admission snapshot.
    return structuredClone(snapshot.value);
  }

  private candidates(entry: MCPCatalogEntry, operation: Operation): Projection[] {
    const value = this.capabilities();
    if (
      this.settings.enabled !== true ||
      (operation !== 'use' &&
        (this.settings[operation] !== true || value.flags[operation] !== true)) ||
      ((operation === 'exchange' || operation === 'refresh') &&
        (this.settings.use_authorization_issuance !== true ||
          !value.flags.use_authorization_issuance))
    )
      throw new ManagedOAuthUnavailableError();
    if (entry.auth_type !== 'oauth' || entry.transport !== 'streamable-http' || !entry.remote_url)
      throw new ManagedOAuthUnavailableError();
    return value.profile_versions.filter(
      (p) =>
        p.catalog_entry_name === entry.name &&
        p.environment === this.settings.environment &&
        p.region === this.settings.region &&
        p.exact_resource_uri === entry.remote_url
    );
  }

  resolveEntry(entry: MCPCatalogEntry): MCPManagedOAuthResolvedProfile {
    const candidates = this.candidates(entry, 'new_starts');
    // Never guess a latest profile when the authoritative registry is ambiguous.
    if (candidates.length !== 1) throw new ManagedOAuthUnavailableError();
    return project(candidates[0]!);
  }

  resolve(server: MCPServer, operation: Operation): MCPManagedOAuthResolvedProfile {
    const entry =
      server.catalog_entry_name && findCatalogEntry(this.catalog, server.catalog_entry_name);
    const ref = server.auth?.oauth_managed_profile;
    if (!entry || !ref) throw new ManagedOAuthUnavailableError();
    const matches = this.candidates(entry, operation).filter(
      (p) =>
        p.profile_id === ref.profile_id &&
        p.profile_version === ref.semantic_version &&
        p.catalog_digest === ref.registry_digest &&
        p.environment === ref.environment &&
        p.region === ref.region
    );
    if (matches.length !== 1) throw new ManagedOAuthUnavailableError();
    return project(matches[0]!);
  }
}
