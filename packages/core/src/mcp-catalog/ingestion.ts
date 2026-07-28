/**
 * Registry ingestion and probe sweep.
 *
 * One run walks the registry's cursor pagination, upserts each server by name,
 * then spends a bounded probe budget on entries whose auth type is unknown or
 * stale. Both halves are designed to degrade rather than fail: the registry is
 * a third party, the probe targets are arbitrary internet hosts, and neither is
 * allowed to leave the catalog in a worse state than not running at all.
 *
 * The caller supplies a `withRepository` factory rather than a repository,
 * because a run lasts minutes and must never hold one database transaction
 * across it. Every HTTP call — registry pages and auth probes alike — happens
 * outside any database scope; each database unit spans one page of upserts or
 * one probe write. A run that dies halfway leaves the pages it already
 * committed in place.
 */

import type { MCPCatalogProbeResult } from '@agor/core/types';
import type { MCPCatalogRepository } from '../db/repositories/mcp-catalog';
import { probeRemoteAuthType } from './auth-probe';
import { MCPRegistryClient } from './registry-client';

/** Opens a short database unit and hands a repository to the work inside it. */
export type WithCatalogRepository = <T>(
  work: (repository: MCPCatalogRepository) => Promise<T>
) => Promise<T>;

export interface IngestionOptions {
  registry?: MCPRegistryClient;
  /** Upper bound on pages, so a registry paginating forever cannot spin. */
  maxPages?: number;
  /** Consecutive page failures tolerated before the run gives up. */
  maxConsecutivePageFailures?: number;
  /** Pause between registry pages. The registry is free; do not hammer it. */
  pageDelayMs?: number;
  /** Entries probed per run. */
  probeBudget?: number;
  /** Re-probe entries whose cached verdict is older than this. */
  probeMaxAgeMs?: number;
  /** Pause between probes of distinct hosts. */
  probeDelayMs?: number;
  /** Overall wall-clock budget for the whole run. */
  deadlineMs?: number;
  probe?: (remoteUrl: string) => Promise<MCPCatalogProbeResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface IngestionResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Registry records that could not be normalized onto a catalog row. */
  skipped: number;
  pagesFetched: number;
  pageFailures: number;
  probed: number;
  probeFailures: number;
  /** True when the run stopped early on its deadline or failure budget. */
  truncated: boolean;
}

const DEFAULTS = {
  maxPages: 400,
  maxConsecutivePageFailures: 3,
  pageDelayMs: 250,
  probeBudget: 40,
  probeMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  probeDelayMs: 500,
  deadlineMs: 10 * 60 * 1000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one ingestion + probe sweep.
 *
 * Returns a summary rather than throwing. A registry that is entirely down
 * yields a result with `pagesFetched: 0` and `truncated: true`; the existing
 * catalog rows are untouched.
 */
export async function runCatalogIngestion(
  withRepository: WithCatalogRepository,
  options: IngestionOptions = {}
): Promise<IngestionResult> {
  const registry = options.registry ?? new MCPRegistryClient();
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const maxConsecutivePageFailures =
    options.maxConsecutivePageFailures ?? DEFAULTS.maxConsecutivePageFailures;
  const pageDelayMs = options.pageDelayMs ?? DEFAULTS.pageDelayMs;
  const probeBudget = options.probeBudget ?? DEFAULTS.probeBudget;
  const probeMaxAgeMs = options.probeMaxAgeMs ?? DEFAULTS.probeMaxAgeMs;
  const probeDelayMs = options.probeDelayMs ?? DEFAULTS.probeDelayMs;
  const deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs;
  const probe = options.probe ?? ((remoteUrl: string) => probeRemoteAuthType(remoteUrl));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  const result: IngestionResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    pagesFetched: 0,
    pageFailures: 0,
    probed: 0,
    probeFailures: 0,
    truncated: false,
  };

  const startedAt = now();
  const outOfTime = (): boolean => now() - startedAt >= deadlineMs;

  let cursor: string | undefined;
  let consecutiveFailures = 0;
  // The registry keys on name and we upsert by name, but a single malformed
  // page could still repeat one; deduplicating within a run keeps the write
  // count honest and avoids a pointless second read of the same row.
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    if (outOfTime()) {
      result.truncated = true;
      log('Ingestion deadline reached during registry pagination');
      break;
    }

    let fetched: Awaited<ReturnType<MCPRegistryClient['fetchPage']>>;
    try {
      fetched = await registry.fetchPage(cursor);
      consecutiveFailures = 0;
    } catch (error) {
      result.pageFailures += 1;
      consecutiveFailures += 1;
      log(
        `Registry page fetch failed (${consecutiveFailures}/${maxConsecutivePageFailures}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (consecutiveFailures >= maxConsecutivePageFailures) {
        result.truncated = true;
        break;
      }
      await sleep(pageDelayMs);
      continue;
    }

    result.pagesFetched += 1;
    result.skipped += fetched.skipped;

    const fresh = fetched.entries.filter((entry) => {
      if (seenNames.has(entry.name)) return false;
      seenNames.add(entry.name);
      return true;
    });

    await withRepository(async (repository) => {
      for (const entry of fresh) {
        try {
          const outcome = await repository.upsertRegistryEntry(entry);
          result[outcome] += 1;
        } catch (error) {
          // A single poisoned entry (oversized blob, constraint violation) must
          // not cost the rest of the page its update.
          result.skipped += 1;
          log(
            `Skipped registry entry ${entry.name}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    });

    const nextCursor = fetched.nextCursor;
    if (!nextCursor) break;
    // A registry that hands back a cursor it already gave us would otherwise
    // burn the whole page budget and report a full run.
    if (seenCursors.has(nextCursor)) {
      result.truncated = true;
      log(`Registry returned a repeated cursor (${nextCursor}); stopping pagination`);
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (page === maxPages - 1) {
      result.truncated = true;
      log(`Reached the ${maxPages}-page cap with more pages available; mirror is incomplete`);
    }
    await sleep(pageDelayMs);
  }

  if (probeBudget > 0 && !outOfTime()) {
    const staleBefore = new Date(now() - probeMaxAgeMs);
    let candidates: Awaited<ReturnType<MCPCatalogRepository['findEntriesNeedingProbe']>> = [];
    try {
      candidates = await withRepository((repository) =>
        repository.findEntriesNeedingProbe(staleBefore, probeBudget)
      );
    } catch (error) {
      log(
        `Failed to select probe candidates: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    for (const candidate of candidates) {
      if (outOfTime()) {
        result.truncated = true;
        log('Ingestion deadline reached during probe sweep');
        break;
      }
      if (!candidate.remote_url) continue;
      try {
        // Deliberately outside any database unit: this is an 8s-timeout request
        // to an arbitrary internet host, and holding a transaction open across
        // it would pin a connection and hold back vacuum for the whole sweep.
        const probed = await probe(candidate.remote_url);
        await withRepository((repository) => repository.recordProbeResult(candidate.name, probed));
        result.probed += 1;
      } catch (error) {
        result.probeFailures += 1;
        log(
          `Probe failed for ${candidate.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      await sleep(probeDelayMs);
    }
  }

  return result;
}
