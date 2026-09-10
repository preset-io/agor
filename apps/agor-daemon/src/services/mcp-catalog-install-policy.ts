import { redactMCPAuthSecrets } from '@agor/core/tools/mcp/auth-secrets';
import type { MCPAuth, MCPCatalogEntry, MCPServer, MCPTransport } from '@agor/core/types';

/** Catalog transports, as `mcp_servers` names them. */
export function catalogServerTransport(entry: MCPCatalogEntry): MCPTransport {
  return entry.transport === 'sse' ? 'sse' : 'http';
}

export function sameCatalogEndpoint(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string): string => {
    try {
      const url = new URL(value.trim());
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.href;
    } catch {
      return value.trim();
    }
  };
  return normalize(a) === normalize(b);
}

const RUNTIME_HYDRATED_AUTH_FIELDS = [
  'oauth_access_token',
  'oauth_refresh_token',
  'oauth_token_expires_at',
] as const satisfies readonly (keyof MCPAuth)[];

function significantAuth(value: MCPAuth | undefined): Record<string, unknown> {
  const entries = Object.entries(redactMCPAuthSecrets(value) ?? { type: 'none' }).filter(
    ([key, field]) =>
      field !== undefined && !(RUNTIME_HYDRATED_AUTH_FIELDS as readonly string[]).includes(key)
  );
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function isPrescribedCatalogAuth(
  auth: MCPAuth | undefined,
  prescribed: MCPAuth,
  reconcileMissingCompatibilityMode: boolean,
  configuredClient: boolean
): boolean {
  const actual = significantAuth(auth);
  const expected = significantAuth(prescribed);
  // A reviewed configured-client recipe delegates only these two fields to
  // the saved row. They remain covered by grant fingerprints and redaction;
  // this is not permission to reuse another owner's row secret.
  if (configuredClient) {
    delete actual.oauth_client_id;
    delete actual.oauth_client_secret;
    // Public compatibility overrides are independently authoritative at flow
    // start. Reconnect must preserve them, not mistake Strict for recipe drift
    // and not replace the configured client with a catalog auth object.
    if (
      actual.oauth_compatibility_mode === 'strict' ||
      actual.oauth_compatibility_mode === 'legacy'
    ) {
      delete actual.oauth_compatibility_mode;
      delete expected.oauth_compatibility_mode;
    }
  }
  // Compatibility policy is evaluated from the current catalog. This one
  // reconciliation lets installs created before an entry acquired an explicit
  // strict policy remain the same install without mutating their row.
  if (reconcileMissingCompatibilityMode && actual.oauth_compatibility_mode === undefined) {
    delete expected.oauth_compatibility_mode;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** The OAuth configuration a current catalog entry prescribes. */
export function catalogOAuthConfig(entry: MCPCatalogEntry): MCPAuth {
  const stated = entry.oauth;
  return {
    type: 'oauth',
    oauth_mode: 'per_user',
    ...(stated?.scope ? { oauth_scope: stated.scope } : {}),
    ...(stated?.client_id ? { oauth_client_id: stated.client_id } : {}),
    ...(stated?.dcr_mode ? { oauth_dcr_mode: stated.dcr_mode } : {}),
    ...(stated?.compatibility_mode ? { oauth_compatibility_mode: stated.compatibility_mode } : {}),
  };
}

/**
 * Canonical current-install predicate shared by Connect reuse and OAuth policy.
 * Historical source/stamp alone is never authority: the row must still match
 * the current entry's endpoint, transport, credential routing, and no-header
 * policy. Imported/edited/removed rows therefore fail closed.
 */
export function isCurrentCatalogInstall(
  server: Pick<
    MCPServer,
    'source' | 'catalog_entry_name' | 'transport' | 'url' | 'auth' | 'headers'
  >,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth,
  options: { reconcileMissingCompatibilityMode?: boolean } = {}
): boolean {
  return (
    server.source === 'catalog' &&
    server.catalog_entry_name === entry.name &&
    server.transport === catalogServerTransport(entry) &&
    (entry.oauth?.configured_client
      ? server.url === entry.remote_url
      : sameCatalogEndpoint(server.url, entry.remote_url)) &&
    isPrescribedCatalogAuth(
      server.auth,
      prescribed,
      options.reconcileMissingCompatibilityMode === true,
      entry.oauth?.configured_client === true
    ) &&
    Object.keys(server.headers ?? {}).length === 0
  );
}
