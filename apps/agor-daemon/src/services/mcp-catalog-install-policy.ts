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
  reconcileMissingCompatibilityMode: boolean
): boolean {
  const actual = significantAuth(auth);
  const expected = significantAuth(prescribed);
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
  // The catalog prescribes the endpoints/profile, not a customer app identity
  // or its grant mode. Accept only that narrow configured-client shape (plus
  // Shared OAuth, as for any other customer app); all other fields still
  // participate in exact prescription comparison below.
  if (
    entry.oauth?.configured_client &&
    server.auth?.oauth_client_id &&
    (!entry.oauth.configured_client.secret_required || server.auth.oauth_client_secret)
  ) {
    prescribed = {
      ...prescribed,
      oauth_client_id: server.auth.oauth_client_id,
      ...(server.auth.oauth_client_secret
        ? { oauth_client_secret: server.auth.oauth_client_secret }
        : {}),
      ...(server.auth.oauth_mode === 'shared' ? { oauth_mode: 'shared' as const } : {}),
    };
  }
  return (
    server.source === 'catalog' &&
    server.catalog_entry_name === entry.name &&
    server.transport === catalogServerTransport(entry) &&
    sameCatalogEndpoint(server.url, entry.remote_url) &&
    isPrescribedCatalogAuth(
      server.auth,
      prescribed,
      options.reconcileMissingCompatibilityMode === true
    ) &&
    Object.keys(server.headers ?? {}).length === 0
  );
}

/**
 * `isCurrentCatalogInstall` for a caller that cannot re-probe the endpoint —
 * the widget resolving an install the Catalog drawer just made.
 *
 * The allowed auth comes from the ENTRY, never from the row: an OAuth entry
 * admits only its OAuth recipe (the caller still checks the grant), a key only
 * under the entry's reviewed bearer recipe, and an open row only for an entry
 * that declares no auth. A row whose auth was edited to something the entry
 * does not prescribe — say an OAuth install with OAuth removed — is not a
 * current install, even with the catalog URL kept.
 */
export function isCurrentCatalogInstallOfEntry(
  server: Parameters<typeof isCurrentCatalogInstall>[0],
  entry: MCPCatalogEntry & { remote_url: string }
): boolean {
  const type = server.auth?.type ?? 'none';
  const prescribed: MCPAuth | undefined =
    type === 'oauth' && entry.auth_type === 'oauth'
      ? catalogOAuthConfig(entry)
      : type === 'bearer' && entry.credentials?.scheme === 'bearer'
        ? { type: 'bearer', token: server.auth?.token }
        : type === 'none' && entry.auth_type === 'none'
          ? { type: 'none' }
          : undefined;
  return Boolean(
    prescribed &&
      isCurrentCatalogInstall(server, entry, prescribed, {
        reconcileMissingCompatibilityMode: true,
      })
  );
}
