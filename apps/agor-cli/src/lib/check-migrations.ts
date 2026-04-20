/**
 * Pre-flight migration check for CLI commands that start the daemon.
 *
 * The daemon itself also checks migrations on startup (and calls process.exit(1)
 * if any are pending). That is sufficient in foreground mode, but when the
 * daemon is spawned as a detached background process, its stderr is redirected
 * into ~/.agor/logs/daemon.log — so the user sees no error at their terminal
 * prompt and the failure looks silent.
 *
 * This helper lets the CLI surface the same failure inline on stderr *before*
 * it spawns the daemon, so the user gets an actionable error at the terminal
 * (with a pointer to `agor db migrate`) and the CLI exits with a non-zero
 * status code.
 *
 * The `PendingMigrationsInfo` type and `formatPendingMigrationsMessage`
 * formatter live in `@agor/core/db` and are re-exported here for
 * convenience; the daemon uses the same formatter so the two call sites
 * cannot drift apart.
 */

import {
  checkMigrationStatus,
  createDatabase,
  formatPendingMigrationsMessage,
  getDatabaseUrl,
  type PendingMigrationsInfo,
} from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';

export { formatPendingMigrationsMessage, type PendingMigrationsInfo };

/**
 * Returns info about pending migrations, or null if the database is up to date.
 *
 * Deliberately does not call process.exit — callers format their own user-facing
 * error message and decide how to exit. This keeps the helper pure and testable.
 *
 * @param dbUrl - Optional explicit database URL. Defaults to `getDatabaseUrl()`
 *   (env vars > ~/.agor/config.yaml > default). Pass an explicit URL when the
 *   caller has already resolved one from a custom config, or in tests.
 */
export async function getPendingMigrationsInfo(
  dbUrl: string = getDatabaseUrl()
): Promise<PendingMigrationsInfo | null> {
  const db = createDatabase({ url: dbUrl });
  const status = await checkMigrationStatus(db);

  if (!status.hasPending) {
    return null;
  }

  return {
    dbUrl,
    dbPath: extractDbFilePath(dbUrl),
    pending: status.pending,
  };
}
