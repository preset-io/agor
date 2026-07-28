/**
 * Client for the official MCP registry (https://registry.modelcontextprotocol.io).
 *
 * The registry is public and unauthenticated. It supplies breadth and stable
 * reverse-DNS identity; it has no notion of category, popularity, or declared
 * auth type, which is exactly what the curated overlay adds on top.
 */

import type {
  MCPCatalogPackage,
  MCPCatalogRegistryUpsert,
  MCPCatalogRemote,
  MCPCatalogTransport,
} from '@agor/core/types';

export const DEFAULT_MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** Key under which the registry publishes its own bookkeeping metadata. */
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

/** Registry-side cap; asking for more is silently clamped. */
const MAX_PAGE_SIZE = 100;

interface RegistryPage {
  servers?: unknown[];
  metadata?: { nextCursor?: string; count?: number };
}

/** A page of registry records already normalized onto the catalog's shape. */
export interface RegistryFetchPage {
  entries: MCPCatalogRegistryUpsert[];
  /** Records the registry returned that could not be normalized. */
  skipped: number;
  nextCursor?: string;
}

export interface RegistryClientOptions {
  baseUrl?: string;
  /** Per-request timeout. The registry is a third party on the critical path of nothing. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asDate(value: unknown): Date | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Registry transport strings are open-ended. Anything we do not recognize is
 * dropped rather than stored, so `transport` always means something to the
 * connect flow.
 */
function normalizeTransport(value: unknown): MCPCatalogTransport | undefined {
  switch (asString(value)) {
    case 'streamable-http':
    case 'http':
      return 'streamable-http';
    case 'sse':
      return 'sse';
    case 'stdio':
      return 'stdio';
    default:
      return undefined;
  }
}

function normalizeRemotes(value: unknown): MCPCatalogRemote[] {
  if (!Array.isArray(value)) return [];
  const remotes: MCPCatalogRemote[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const url = asString(record.url);
    const type = asString(record.type);
    if (!url || !type) continue;
    // Only http(s) endpoints are connectable, and refusing everything else here
    // keeps unvalidated schemes out of the probe's fetch target.
    if (!/^https?:\/\//i.test(url)) continue;
    remotes.push({ type, url });
  }
  return remotes;
}

function normalizePackages(value: unknown): MCPCatalogPackage[] {
  if (!Array.isArray(value)) return [];
  const packages: MCPCatalogPackage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const registryType = asString(record.registryType);
    const identifier = asString(record.identifier);
    if (!registryType || !identifier) continue;
    const transport = record.transport as Record<string, unknown> | undefined;
    packages.push({
      registry_type: registryType,
      identifier,
      version: asString(record.version),
      runtime_hint: asString(record.runtimeHint),
      transport_type: asString(transport?.type),
    });
  }
  return packages;
}

function normalizeIcons(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value
    .map((raw) =>
      raw && typeof raw === 'object' ? asString((raw as Record<string, unknown>).src) : undefined
    )
    .filter((url): url is string => Boolean(url) && /^https?:\/\//i.test(url as string));
  return urls.length > 0 ? urls : undefined;
}

/**
 * Convert one registry record into the columns ingestion owns.
 *
 * Returns null for anything without a usable `name`, which is the catalog's
 * natural key — a record we cannot key cannot be upserted or deduplicated.
 */
export function normalizeRegistryServer(record: unknown): MCPCatalogRegistryUpsert | null {
  if (!record || typeof record !== 'object') return null;
  const envelope = record as Record<string, unknown>;
  const server = envelope.server as Record<string, unknown> | undefined;
  if (!server || typeof server !== 'object') return null;

  const name = asString(server.name);
  if (!name) return null;

  const meta = envelope._meta as Record<string, unknown> | undefined;
  const official = meta?.[OFFICIAL_META_KEY] as Record<string, unknown> | undefined;

  const remotes = normalizeRemotes(server.remotes);
  const packages = normalizePackages(server.packages);
  const repository = server.repository as Record<string, unknown> | undefined;
  const primaryRemote = remotes[0];

  return {
    name,
    version: asString(server.version),
    registry_updated_at: asDate(official?.updatedAt),
    title: asString(server.title),
    description: asString(server.description),
    website_url: asString(server.websiteUrl),
    repository_url: asString(repository?.url),
    repository_source: asString(repository?.source),
    transport: primaryRemote
      ? normalizeTransport(primaryRemote.type)
      : normalizeTransport(packages[0]?.transport_type),
    remote_url: primaryRemote?.url,
    remotes: remotes.length > 0 ? remotes : undefined,
    packages: packages.length > 0 ? packages : undefined,
    registry_icons: normalizeIcons(server.icons),
    registry_status: asString(official?.status),
  };
}

export class MCPRegistryClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RegistryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_MCP_REGISTRY_URL).replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch one cursor-paginated page of latest-version servers.
   *
   * Throws on transport failure or a non-2xx response so the caller can decide
   * whether to abandon the run; a page whose individual records are malformed
   * does not throw, it reports them as `skipped`.
   */
  async fetchPage(cursor?: string, pageSize = MAX_PAGE_SIZE): Promise<RegistryFetchPage> {
    const url = new URL('/v0/servers', this.baseUrl);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(Math.min(pageSize, MAX_PAGE_SIZE)));
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await this.fetchImpl(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`MCP registry responded ${response.status} for ${url.pathname}`);
    }

    const page = (await response.json()) as RegistryPage;
    const records = Array.isArray(page.servers) ? page.servers : [];

    const entries: MCPCatalogRegistryUpsert[] = [];
    let skipped = 0;
    for (const record of records) {
      const normalized = normalizeRegistryServer(record);
      if (normalized) entries.push(normalized);
      else skipped += 1;
    }

    return { entries, skipped, nextCursor: page.metadata?.nextCursor };
  }
}
