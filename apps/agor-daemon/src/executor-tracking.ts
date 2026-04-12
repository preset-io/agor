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
    `🛑 [Stop] Sending SIGTERM to executor PID ${proc.pid} (session ${sessionId.substring(0, 8)})`
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
