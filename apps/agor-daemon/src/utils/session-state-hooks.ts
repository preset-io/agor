/**
 * Session State Hooks
 *
 * Pre/post turn hooks for stateless_fs_mode.
 * pullIfNeeded: restores session file from DB before SDK subprocess starts.
 * pushAsync: serializes session file to DB after SDK subprocess exits.
 *
 * Lives in the daemon (not core) because these hooks are only invoked from
 * register-services.ts and operate on the daemon's DB + filesystem directly.
 */

import type { Database } from '@agor/core/db';
import { SerializedSessionRepository } from '@agor/core/db';
import type { AgenticToolName } from '@agor/core/types';
import {
  computeFileHash,
  findCodexSessionFile,
  getCodexHome,
  getSessionFilePath,
  restoreFile,
  serializeFile,
} from './session-state';

const STALE_PROCESSING_THRESHOLD_MS = 30_000; // 30 seconds

interface PullContext {
  db: Database;
  sessionId: string;
  sdkSessionId: string;
  worktreePath: string;
  tool: AgenticToolName;
  /** Override for the executor user's home directory (insulated/strict modes) */
  executorHomeDir?: string;
}

interface PushContext {
  db: Database;
  sessionId: string;
  worktreeId: string;
  taskId: string;
  sdkSessionId: string;
  worktreePath: string;
  tool: AgenticToolName;
  lastKnownMd5?: string;
  /** Override for the executor user's home directory (insulated/strict modes) */
  executorHomeDir?: string;
}

/**
 * Pull: run before spawning the SDK subprocess.
 * Checks whether the local session file is current. Restores from DB if not.
 *
 * Decision table (in order):
 * 1. No serialized_sessions row → fresh session, proceed
 * 2. Latest row is 'processing' and created_at < (now - 30s) → stale, delete it,
 *    fall through to check previous 'done' row
 * 3. Latest row is 'done', md5 matches local file → fast path, proceed
 * 4. Latest row is 'done', md5 differs → restore from DB (DB wins)
 * 5. No 'done' row, no local file → fresh session, proceed
 */
export async function pullIfNeeded(ctx: PullContext): Promise<void> {
  const repo = new SerializedSessionRepository(ctx.db);

  // Both claude-code and codex now resolve transcripts under the executor
  // user's HOME (~/.claude or ~/.codex). For simple mode executorHomeDir is
  // undefined and the helpers fall back to os.homedir().
  const filePath = getSessionFilePath(
    ctx.tool,
    ctx.worktreePath,
    ctx.sdkSessionId,
    ctx.executorHomeDir
  );

  // Check latest row (any status)
  let latest = await repo.findLatest(ctx.sessionId);

  if (!latest) {
    // Case 1: No rows at all → fresh session
    return;
  }

  // Case 2: Stale 'processing' row
  if (latest.status === 'processing') {
    const age = Date.now() - latest.created_at;
    if (age > STALE_PROCESSING_THRESHOLD_MS) {
      console.log(
        `[session-state] Cleaning stale 'processing' row ${latest.id.substring(0, 8)} (age: ${Math.round(age / 1000)}s)`
      );
      await repo.deleteById(latest.id);
      // Fall through: check if there's a 'done' row behind it
      latest = await repo.findLatestDone(ctx.sessionId);
      if (!latest) {
        // Case 5: No done row after cleanup
        return;
      }
    } else {
      // Still processing, not stale — another pod may be active.
      // Fall back to the latest 'done' row so we don't start with no transcript.
      console.warn(
        `[session-state] Latest row is 'processing' (age: ${Math.round(age / 1000)}s), falling back to latest done row`
      );
      latest = await repo.findLatestDone(ctx.sessionId);
      if (!latest) {
        // No done row available — proceed without restore
        return;
      }
    }
  }

  // At this point, latest.status === 'done'
  const localMd5 = await computeFileHash(filePath);

  // Case 3: MD5 matches → fast path
  if (latest.md5 === localMd5) {
    return;
  }

  // Case 4: MD5 differs → restore from DB
  if (!latest.payload) {
    console.warn(
      `[session-state] 'done' row ${latest.id.substring(0, 8)} has no payload, skipping restore`
    );
    return;
  }

  console.log(
    `[session-state] Restoring session file from DB (row ${latest.id.substring(0, 8)}, turn ${latest.turn_index})`
  );
  await restoreFile(filePath, latest.payload);
}

/**
 * Push: run after SDK subprocess exits. Fire-and-forget (never awaited by caller).
 * Skips if file hash unchanged. Otherwise: insertProcessing → gzip → markDone → deletePreviousTurns.
 */
export function pushAsync(ctx: PushContext): void {
  // Fire and forget — errors are logged but never propagated
  void doPush(ctx).catch((err) => {
    console.error('[session-state] pushAsync failed:', err instanceof Error ? err.message : err);
  });
}

async function doPush(ctx: PushContext): Promise<void> {
  const repo = new SerializedSessionRepository(ctx.db);

  // For Codex, find the actual session file (may be in a date-based subdirectory)
  let filePath: string;
  if (ctx.tool === 'codex') {
    const codexHome = getCodexHome(ctx.executorHomeDir);
    const found = await findCodexSessionFile(codexHome, ctx.sdkSessionId);
    if (!found) {
      // No session file found — Codex may not have written one (e.g. error before first turn)
      return;
    }
    filePath = found;
  } else {
    filePath = getSessionFilePath(
      ctx.tool,
      ctx.worktreePath,
      ctx.sdkSessionId,
      ctx.executorHomeDir
    );
  }

  // Compute current hash
  const currentMd5 = await computeFileHash(filePath);

  // Skip if file doesn't exist
  if (currentMd5 === '') {
    return;
  }

  // Skip if hash unchanged
  if (ctx.lastKnownMd5 && currentMd5 === ctx.lastKnownMd5) {
    return;
  }

  // Determine turn_index
  const latestRow = await repo.findLatest(ctx.sessionId);
  const turnIndex = latestRow ? latestRow.turn_index + 1 : 0;

  // Insert processing row (fast — no payload yet)
  const row = await repo.insertProcessing({
    sessionId: ctx.sessionId,
    worktreeId: ctx.worktreeId,
    taskId: ctx.taskId,
    turnIndex,
    md5: currentMd5,
  });

  // Gzip the file
  const payload = await serializeFile(filePath);

  // Mark done with payload
  await repo.markDone(row.id, payload);

  // Clean up old rows (only delete turns older than this one — safe against concurrent pushes)
  await repo.deletePreviousTurns(ctx.sessionId, turnIndex);

  console.log(
    `[session-state] Pushed session state (turn ${turnIndex}, ${payload.length} bytes gzipped)`
  );
}
