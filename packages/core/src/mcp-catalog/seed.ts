/**
 * Seed the curated overlay from the checked-in `curated.yaml`.
 *
 * Runs on every daemon start. Curation lives in the repository, so the file is
 * the source of truth: reapplying it is how an edited benefit line or a
 * re-ranked entry reaches an existing install, and it is idempotent by design.
 */

import { type CuratedCatalogEntry, loadCuratedCatalog } from './curated-loader';
import type { WithCatalogRepository } from './ingestion';

export interface SeedCuratedCatalogResult {
  created: number;
  updated: number;
  failed: number;
  /** Rows whose curation was withdrawn because the file stopped naming them. */
  retired: number;
  /**
   * Withdrawals that could not be applied. Non-zero means curation the file no
   * longer contains is still being shown, which `retired: 0` cannot distinguish
   * from "nothing was removed".
   */
  retirementFailures: number;
}

export interface SeedCuratedCatalogOptions {
  /** Overrides the checked-in file. Tests supply parsed entries directly. */
  entries?: CuratedCatalogEntry[];
  filePath?: string;
  log?: (message: string) => void;
}

/**
 * Reconcile the catalog against the file: apply every entry it names, then
 * withdraw curation from the rows it no longer does.
 *
 * Applying alone would make the file authoritative only for entries still in
 * it. A deleted entry would keep its shelf and its benefit copy indefinitely,
 * and a rename — a delete and an add, as far as the natural key is concerned —
 * would leave the old name sitting beside the new one, both curated.
 *
 * A single entry that fails to write is counted and skipped: one bad row must
 * not cost the other forty-nine their curation, and the next run retries it.
 */
export async function seedCuratedCatalog(
  withRepository: WithCatalogRepository,
  options: SeedCuratedCatalogOptions = {}
): Promise<SeedCuratedCatalogResult> {
  const log = options.log ?? (() => {});
  // Read and validate the file before opening any database unit.
  const entries = options.entries ?? (await loadCuratedCatalog(options.filePath));

  // One database unit per entry: on Postgres a failed statement aborts the
  // enclosing transaction, so a shared unit would turn one bad row into a
  // rollback of every row seeded before it while still counting them.
  const result: SeedCuratedCatalogResult = {
    created: 0,
    updated: 0,
    failed: 0,
    retired: 0,
    retirementFailures: 0,
  };
  for (const entry of entries) {
    try {
      const outcome = await withRepository((repository) => repository.upsertCuration(entry));
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `Failed to seed curated catalog entry ${entry.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Reconciling against a file that produced no entries would withdraw curation
  // from the entire catalog. The loader rejects an empty file, but the seam that
  // supplies entries directly does not, and "the list is empty" is far more
  // likely to be a mistake than an instruction.
  if (entries.length === 0) return result;
  // Nothing was applied, so the run has no evidence about which entries are
  // current — retiring on that basis would act on a failure as if it were a
  // deletion.
  if (result.failed > 0 && result.created + result.updated === 0) {
    log('Skipping curation reconciliation: no entry could be applied');
    return result;
  }

  const current = new Set(entries.map((entry) => entry.name));
  let stale: string[];
  try {
    const curated = await withRepository((repository) => repository.listCuratedNames());
    stale = curated.filter((name) => !current.has(name));
  } catch (error) {
    result.retirementFailures += 1;
    log(
      `Failed to list curated entries for reconciliation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return result;
  }

  for (const name of stale) {
    try {
      const outcome = await withRepository((repository) => repository.retireCuration(name));
      if (outcome === 'absent') continue;
      result.retired += 1;
      log(`Curation withdrawn from ${name} (${outcome}); it is no longer in curated.yaml`);
    } catch (error) {
      result.retirementFailures += 1;
      log(
        `Failed to withdraw curation from ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return result;
}
