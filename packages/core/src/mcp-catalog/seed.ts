/**
 * Seed the curated overlay from the checked-in `curated.yaml`.
 *
 * Runs on every daemon start. Curation lives in the repository, so the file is
 * the source of truth: reapplying it is how an edited benefit line or a
 * re-ranked entry reaches an existing install, and it is idempotent by design.
 */

import type { MCPCatalogRepository } from '../db/repositories/mcp-catalog';
import { type CuratedCatalogEntry, loadCuratedCatalog } from './curated-loader';

export interface SeedCuratedCatalogResult {
  created: number;
  updated: number;
  failed: number;
}

export interface SeedCuratedCatalogOptions {
  /** Overrides the checked-in file. Tests supply parsed entries directly. */
  entries?: CuratedCatalogEntry[];
  filePath?: string;
  log?: (message: string) => void;
}

/**
 * Apply every curated entry.
 *
 * A single entry that fails to write is counted and skipped: one bad row must
 * not cost the other forty-nine their curation, and the next run retries it.
 */
export async function seedCuratedCatalog(
  repository: MCPCatalogRepository,
  options: SeedCuratedCatalogOptions = {}
): Promise<SeedCuratedCatalogResult> {
  const log = options.log ?? (() => {});
  const entries = options.entries ?? (await loadCuratedCatalog(options.filePath));

  const result: SeedCuratedCatalogResult = { created: 0, updated: 0, failed: 0 };
  for (const entry of entries) {
    try {
      const outcome = await repository.upsertCuration(entry);
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
  return result;
}
