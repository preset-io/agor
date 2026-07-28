/**
 * MCP Catalog Ingestion Worker
 *
 * Periodically mirrors the public MCP registry into `mcp_catalog_entries` and
 * spends a bounded probe budget discovering which entries require OAuth. On
 * every start it also reapplies the checked-in `curated.yaml`, so an edited
 * benefit line or a re-ranked entry reaches an existing install on restart.
 *
 * Tenancy: the catalog is global. Both writers run under
 * `runWithSystemDatabaseScope(..., { capability: 'mcp_catalog_ingestion' })`,
 * which is the only context the table's Postgres write policy accepts, and
 * which refuses to be entered from an active tenant context. There is no
 * per-tenant variant to schedule — Agor resolves tenants from request auth and
 * has no registry of them to enumerate.
 */

import type { AgorMCPCatalogSettings } from '@agor/core/config';
import {
  MCPCatalogRepository,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  type IngestionResult,
  MCPRegistryClient,
  runCatalogIngestion,
  seedCuratedCatalog,
} from '@agor/core/mcp-catalog';

/** How often a running daemon re-syncs the registry. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the first run so daemon boot is not competing with it. */
const DEFAULT_INITIAL_DELAY_MS = 60_000;

export interface MCPCatalogIngestionOptions {
  intervalMs?: number;
  initialDelayMs?: number;
  /** Skip the network sync and only reapply curation. */
  registrySyncEnabled?: boolean;
  /** Entries auth-probed per run. Zero disables probing. */
  probeBudget?: number;
  registryUrl?: string;
}

/**
 * Resolve worker options from `~/.agor/config.yaml`.
 *
 * Registry sync reaches a third party and the auth probe reaches arbitrary
 * registry-published hosts, so both are operator-controllable. Turning them off
 * leaves the repo-shipped curated overlay, which still seeds offline.
 */
export function resolveMCPCatalogOptions(
  settings: AgorMCPCatalogSettings | undefined
): MCPCatalogIngestionOptions {
  const options: MCPCatalogIngestionOptions = {
    registrySyncEnabled: settings?.registry_sync_enabled !== false,
  };
  if (typeof settings?.sync_interval_hours === 'number' && settings.sync_interval_hours > 0) {
    options.intervalMs = settings.sync_interval_hours * 60 * 60 * 1000;
  }
  if (typeof settings?.probe_budget === 'number' && settings.probe_budget >= 0) {
    options.probeBudget = settings.probe_budget;
  }
  if (settings?.registry_url?.trim()) options.registryUrl = settings.registry_url.trim();
  return options;
}

export class MCPCatalogIngestionWorker {
  private intervalHandle?: ReturnType<typeof setInterval>;
  private initialHandle?: ReturnType<typeof setTimeout>;
  private running = false;
  private lastResult: IngestionResult | null = null;
  private lastError: string | null = null;

  constructor(
    private db: TenantScopeAwareDatabase,
    private options: MCPCatalogIngestionOptions = {}
  ) {}

  start(): void {
    if (this.intervalHandle || this.initialHandle) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialHandle = setTimeout(() => {
      this.initialHandle = undefined;
      void this.runOnce();
      this.intervalHandle = setInterval(() => void this.runOnce(), intervalMs);
    }, this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.initialHandle) clearTimeout(this.initialHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.initialHandle = undefined;
    this.intervalHandle = undefined;
  }

  getLastResult(): IngestionResult | null {
    return this.lastResult;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Reapply curation, then sync the registry.
   *
   * Curation runs first so a fresh install has recognizable, connectable cards
   * before the multi-minute registry walk finishes. Each half opens its own
   * short system database unit rather than holding one across the whole run.
   */
  async runOnce(): Promise<IngestionResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      await this.withSystemScope('mcp-catalog curation seed', async (repository) => {
        const seeded = await seedCuratedCatalog(repository, {
          log: (message) => console.warn(`[mcp-catalog] ${message}`),
        });
        console.log(
          `📚 MCP catalog curation applied (created: ${seeded.created}, updated: ${seeded.updated}, failed: ${seeded.failed})`
        );
      });

      if (this.options.registrySyncEnabled === false) return null;

      const result = await this.withSystemScope('mcp-catalog registry sync', (repository) =>
        runCatalogIngestion(repository, {
          ...(this.options.registryUrl
            ? { registry: new MCPRegistryClient({ baseUrl: this.options.registryUrl }) }
            : {}),
          ...(this.options.probeBudget === undefined
            ? {}
            : { probeBudget: this.options.probeBudget }),
          log: (message) => console.warn(`[mcp-catalog] ${message}`),
        })
      );
      this.lastResult = result;
      this.lastError = null;
      console.log(
        `📚 MCP catalog sync finished (created: ${result.created}, updated: ${result.updated}, unchanged: ${result.unchanged}, skipped: ${result.skipped}, probed: ${result.probed}, truncated: ${result.truncated})`
      );
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[mcp-catalog] ingestion run failed:', error);
      return null;
    } finally {
      this.running = false;
    }
  }

  private withSystemScope<T>(
    reason: string,
    work: (repository: MCPCatalogRepository) => Promise<T>
  ): Promise<T> {
    // Timers inherit AsyncLocalStorage. Detach any ambient tenant identity and
    // transaction before entering system scope, which refuses to open from one.
    return runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          this.db,
          reason,
          (scopedDb) => work(new MCPCatalogRepository(scopedDb)),
          { capability: 'mcp_catalog_ingestion' }
        )
      )
    );
  }
}
