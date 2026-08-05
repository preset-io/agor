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
  type WithCatalogRepository,
} from '@agor/core/mcp-catalog';

/** How often a running daemon re-syncs the registry. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the first run so daemon boot is not competing with it. */
const DEFAULT_INITIAL_DELAY_MS = 60_000;

/**
 * Node's timer ceiling. A delay above this does not run late — it overflows the
 * 32-bit field and is silently rescheduled at 1 ms, turning "sync twice a month"
 * into a continuous loop that reapplies all fifty curated rows forever. The
 * curation seed runs before the registry-sync check, so this churns the database
 * even with the sync switched off.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Floor on the interval, so a mistyped small value cannot spin either. */
const MIN_INTERVAL_MS = 60_000;

/** Hold a delay inside the range `setTimeout` and `setInterval` honour. */
function clampTimerMs(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), MAX_TIMER_MS);
}

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
 * registry-published hosts, so both are operator-controllable — and the sync is
 * opt-in, because Phase 1 has no UI that renders uncurated registry rows. The
 * repo-shipped curated overlay seeds either way, including offline.
 */
export function resolveMCPCatalogOptions(
  settings: AgorMCPCatalogSettings | undefined
): MCPCatalogIngestionOptions {
  const options: MCPCatalogIngestionOptions = {
    registrySyncEnabled: settings?.registry_sync_enabled === true,
  };
  if (
    typeof settings?.sync_interval_hours === 'number' &&
    Number.isFinite(settings.sync_interval_hours) &&
    settings.sync_interval_hours > 0
  ) {
    options.intervalMs = clampTimerMs(
      settings.sync_interval_hours * 60 * 60 * 1000,
      MIN_INTERVAL_MS
    );
  }
  if (typeof settings?.probe_budget === 'number' && settings.probe_budget >= 0) {
    options.probeBudget = settings.probe_budget;
  }
  if (settings?.registry_url?.trim()) options.registryUrl = settings.registry_url.trim();
  return options;
}

/**
 * Assumes one daemon per database.
 *
 * `running` below is an in-process boolean, so it stops this worker overlapping
 * itself and nothing more. Two daemons against one Postgres both wake on their
 * own six-hour interval and both read-modify-write the same rows: the `data`
 * blob merges are read-then-write with no row lock, so a concurrent pair is
 * last-writer-wins, and two INSERTs of the same new `name` race the unique index
 * into a violation that surfaces as `entryFailures`. The previous run-long
 * transaction serialized this by accident; per-row units do not.
 *
 * The damage is bounded — the mirror is reconstructable from the registry and
 * `curated.yaml`, and the next run corrects it — so this is a correctness
 * limitation, not a data-loss risk. Serializing properly wants a
 * `pg_advisory_lock` around the run, which is tracked separately rather than
 * bolted on here.
 */
export class MCPCatalogIngestionWorker {
  private intervalHandle?: ReturnType<typeof setInterval>;
  private initialHandle?: ReturnType<typeof setTimeout>;
  private running = false;
  private lastResult: IngestionResult | null = null;
  private lastError: string | null = null;
  /**
   * Where the next sync resumes.
   *
   * The registry takes far longer to walk than one run's deadline allows, so a
   * run that always started at the first page would re-read the same head every
   * six hours and never reach the tail. Held in memory rather than persisted: a
   * daemon restart costs one repeated head, which the `unchanged` fast path
   * makes cheap, and that is not worth a table for.
   */
  private resumeCursor: string | undefined;

  constructor(
    private db: TenantScopeAwareDatabase,
    private options: MCPCatalogIngestionOptions = {}
  ) {}

  start(): void {
    if (this.intervalHandle || this.initialHandle) return;
    // Clamped here rather than only where config is parsed, because this is the
    // call that overflows: a caller constructing the worker directly reaches
    // `setInterval` without passing through `resolveMCPCatalogOptions`.
    const intervalMs = clampTimerMs(
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS
    );
    const initialDelayMs = clampTimerMs(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS, 0);
    this.initialHandle = setTimeout(() => {
      this.initialHandle = undefined;
      void this.runOnce();
      this.intervalHandle = setInterval(() => void this.runOnce(), intervalMs);
    }, initialDelayMs);
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
   * before the multi-minute registry walk finishes. Neither half holds a
   * database unit across the run; both open one per row they write.
   */
  async runOnce(): Promise<IngestionResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const seeded = await seedCuratedCatalog(this.withSystemScope('mcp-catalog curation seed'), {
        log: (message) => console.warn(`[mcp-catalog] ${message}`),
      });
      console.log(
        `📚 MCP catalog curation applied (created: ${seeded.created}, updated: ${seeded.updated}, retired: ${seeded.retired}, failed: ${seeded.failed}, retirementFailures: ${seeded.retirementFailures})`
      );

      // Opt-in, so anything other than an explicit `true` means off. Testing
      // `=== false` would turn the sync on for a caller that constructed the
      // worker directly and left the option undefined, which is backwards for a
      // feature whose whole point is that it makes outbound requests.
      if (this.options.registrySyncEnabled !== true) return null;

      const result = await runCatalogIngestion(this.withSystemScope('mcp-catalog registry sync'), {
        ...(this.options.registryUrl
          ? { registry: new MCPRegistryClient({ baseUrl: this.options.registryUrl }) }
          : {}),
        ...(this.options.probeBudget === undefined
          ? {}
          : { probeBudget: this.options.probeBudget }),
        ...(this.resumeCursor === undefined ? {} : { startCursor: this.resumeCursor }),
        log: (message) => console.warn(`[mcp-catalog] ${message}`),
      });
      this.resumeCursor = result.nextCursor;
      this.lastResult = result;
      this.lastError = null;
      console.log(
        `📚 MCP catalog sync finished (created: ${result.created}, updated: ${result.updated}, unchanged: ${result.unchanged}, withdrawn: ${result.withdrawn}, skipped: ${result.skipped}, probed: ${result.probed}, truncated: ${result.truncated}, resumes: ${result.nextCursor ? 'yes' : 'from the start'}) — failures: entry=${result.entryFailures}, retirement=${result.retirementFailures}, probe=${result.probeFailures}, page=${result.pageFailures}`
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

  /**
   * Build the factory the catalog writers use to open one short system database
   * unit per row.
   *
   * Returning a factory rather than wrapping the whole run is the point. A full
   * sync spans minutes of registry pagination and probe requests; holding one
   * Postgres transaction across that would pin a pooled connection, hold back
   * autovacuum database-wide, and discard every upsert if the connection
   * dropped near the end. Per row rather than per page because a failed
   * statement aborts a Postgres transaction outright — a shared unit would turn
   * one bad row into a rollback of every row written before it.
   */
  private withSystemScope(reason: string): WithCatalogRepository {
    return <T>(work: (repository: MCPCatalogRepository) => Promise<T>): Promise<T> =>
      // These two exits are load-bearing and cannot be removed. Deleting them
      // leaves every test passing, because tests call `runOnce` from no scope at
      // all. In production `app.set('mcpCatalogIngestion', ...)` hands the
      // worker to anything holding a request scope, and
      // `runWithSystemDatabaseScope` REUSES an existing system scope instead of
      // opening a second transaction — so a caller inside one would get a single
      // transaction spanning the whole run, silently reinstating the defect the
      // per-row factory exists to prevent. (From a tenant scope it throws
      // instead, which is loud but still a broken run.) Exiting first is what
      // makes "one unit per row" true rather than merely intended.
      runWithoutTenantContext(() =>
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
