import { shortId } from '@agor/core/db';

/**
 * Executor PID Tracking
 *
 * In-memory map of session → executor process info for signal-based stopping.
 * When the user clicks Stop, we SIGTERM/SIGKILL the process directly instead of
 * relying on WebSocket ACK protocols.
 */

const executorProcesses = new Map<string, { pid: number; startedAt: Date }>();

/**
 * Track an executor process for a session.
 */
export function trackExecutorProcess(sessionId: string, pid: number): void {
  executorProcesses.set(sessionId, { pid, startedAt: new Date() });
}

/**
 * Remove tracking for a session's executor process.
 */
export function untrackExecutorProcess(sessionId: string): void {
  executorProcesses.delete(sessionId);
}

/**
 * Liveness of a session's tracked executor process.
 *
 * - `alive`   — a PID is tracked and the OS confirms the process exists.
 * - `dead`    — a PID is tracked but the process no longer exists (ESRCH).
 * - `unknown` — no PID is tracked (e.g. never spawned here, or the daemon
 *               restarted and lost its in-memory map). Callers should fall
 *               back to their prior heuristics in this case.
 */
export type ExecutorLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Probe whether a session's executor process is still running.
 *
 * Uses signal 0 (`process.kill(pid, 0)`), which performs an existence/permission
 * check without delivering a signal. In insulated/strict Unix modes the executor
 * runs as a different user, so the daemon may lack permission to signal it — that
 * surfaces as `EPERM`, which still proves the process exists, so we treat it as
 * `alive`. Only `ESRCH` (no such process) is treated as `dead`.
 */
export function getExecutorLiveness(sessionId: string): ExecutorLiveness {
  const proc = executorProcesses.get(sessionId);
  if (!proc) return 'unknown';

  try {
    process.kill(proc.pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: process exists but is owned by another user — still alive.
    if (code === 'EPERM') return 'alive';
    // ESRCH (or anything else we can't interpret as "exists"): treat as dead.
    return 'dead';
  }
}

/**
 * Kill an executor process for a session using Unix signals.
 *
 * Phase 1: SIGTERM (allows graceful shutdown — executor's SIGTERM handler
 *          calls abortController.abort() and patches task status)
 * Phase 2: After 3 seconds, SIGKILL (uncatchable, guaranteed death)
 *
 * @returns true if a process was found and signaled
 */
export function killExecutorProcess(sessionId: string): boolean {
  const proc = executorProcesses.get(sessionId);
  if (!proc) return false;

  try {
    // Check if process is still alive
    process.kill(proc.pid, 0);
  } catch {
    // Process already dead, clean up tracking
    executorProcesses.delete(sessionId);
    return false;
  }

  console.log(
    `🛑 [Stop] Sending SIGTERM to executor PID ${proc.pid} (session ${shortId(sessionId)})`
  );
  try {
    process.kill(proc.pid, 'SIGTERM');
  } catch (err) {
    console.warn(`⚠️  [Stop] SIGTERM failed for PID ${proc.pid}:`, err);
  }

  // Phase 2: SIGKILL after 3 seconds if still alive
  setTimeout(() => {
    try {
      process.kill(proc.pid, 0); // Check if still alive
      console.log(`🛑 [Stop] Process still alive after 3s, sending SIGKILL to PID ${proc.pid}`);
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      // Process already dead — good
    }
  }, 3000);

  return true;
}
