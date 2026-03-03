/**
 * Permission Service (Executor Version)
 *
 * Handles async permission requests from Claude Agent SDK PreToolUse hooks.
 * Emits events via Feathers WebSocket to daemon for broadcasting to UI clients.
 *
 * ## Why this is separate from packages/core/src/permissions/permission-service.ts
 *
 * The core version is used by the daemon for in-process tool execution (sync emitEvent).
 * This executor version uses async emitEvent (events go over Feathers WebSocket to daemon).
 * The two share the same logic but differ in their emitEvent signature (sync vs async),
 * which makes them incompatible as a single class without adding unnecessary abstraction.
 *
 * ## Flow in Feathers/WebSocket Architecture:
 *
 * 1. PreToolUse hook fires → PermissionService.emitRequest()
 * 2. Event sent via Feathers WebSocket to daemon → Daemon broadcasts to UI clients
 * 3. Task/session updated via Feathers client (awaiting_permission)
 * 4. PermissionService.waitForDecision() creates Promise that pauses SDK
 * 5. UI decides → daemon receives decision → WebSocket notification to executor
 * 6. Executor receives permission_resolved event → calls PermissionService.resolvePermission()
 * 7. Promise resolves → SDK resumes execution
 */

import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';

export interface PermissionRequest {
  requestId: string;
  sessionId: SessionID;
  taskId: TaskID;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  timestamp: string;
}

export interface PermissionDecision {
  requestId: string;
  taskId: TaskID;
  allow: boolean;
  reason?: string;
  remember: boolean;
  scope: PermissionScope;
  decidedBy: string; // userId
  timedOut?: boolean; // true when the decision was an automatic timeout (not an explicit deny)
}

// Re-export for convenience
export { PermissionScope };

/** Default permission timeout: 10 minutes */
const DEFAULT_PERMISSION_TIMEOUT_MS = 600_000;

/**
 * Executor version of PermissionService
 * Emits events via IPC to daemon instead of directly via WebSocket
 */
export class PermissionService {
  private pendingRequests = new Map<
    string,
    {
      sessionId: SessionID;
      resolve: (decision: PermissionDecision) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  /**
   * @param emitEvent - Function to emit events via IPC to daemon
   * @param timeoutMs - Permission request timeout in ms (default: 10 minutes)
   */
  constructor(
    private emitEvent: (event: string, data: unknown) => Promise<void>,
    private timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS
  ) {}

  /**
   * Emit a permission request event to daemon (which broadcasts via WebSocket)
   */
  async emitRequest(sessionId: SessionID, request: Omit<PermissionRequest, 'sessionId'>) {
    const fullRequest: PermissionRequest = { ...request, sessionId };
    await this.emitEvent('permission:request', fullRequest);
    console.log(
      `🛡️  [executor] Permission request emitted via IPC: ${request.toolName} for task ${request.taskId}`
    );
  }

  /**
   * Wait for a permission decision from daemon
   * Returns a Promise that pauses SDK execution until resolved
   */
  waitForDecision(
    requestId: string,
    taskId: TaskID,
    sessionId: SessionID,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      // Handle cancellation
      signal.addEventListener('abort', () => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(requestId);
        }
        console.log(`🛡️  [executor] Permission request cancelled: ${requestId}`);
        resolve({
          requestId,
          taskId,
          allow: false,
          reason: 'Cancelled',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
        });
      });

      // Timeout (configurable, default 10 minutes)
      const timeout = setTimeout(async () => {
        this.pendingRequests.delete(requestId);
        console.warn(`⏰ [executor] Permission request timed out: ${requestId}`);

        // Broadcast timeout to UI via daemon
        try {
          await this.emitEvent('permission:timeout', { requestId, sessionId, taskId });
        } catch (err) {
          console.error(`⚠️  [executor] Failed to emit permission:timeout event:`, err);
        }

        resolve({
          requestId,
          taskId,
          allow: false,
          reason: 'Timed out',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
          timedOut: true,
        });
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, { sessionId, resolve, timeout });
      console.log(
        `🛡️  [executor] Waiting for permission decision: ${requestId} (timeout: ${Math.round(this.timeoutMs / 1000)}s)`
      );
    });
  }

  /**
   * Resolve a pending permission request
   * Called by IPC handler when daemon sends permission_resolved notification
   */
  resolvePermission(decision: PermissionDecision) {
    const pending = this.pendingRequests.get(decision.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(decision);
      this.pendingRequests.delete(decision.requestId);
      console.log(
        `🛡️  [executor] Permission resolved: ${decision.requestId} → ${decision.allow ? 'ALLOW' : 'DENY'}`
      );
    } else {
      console.warn(`⚠️  [executor] No pending request found for ${decision.requestId}`);
    }
  }

  /**
   * Cancel all pending permission requests for a session
   */
  cancelPendingRequests(sessionId: SessionID) {
    let cancelledCount = 0;

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.resolve({
          requestId,
          taskId: '' as TaskID,
          allow: false,
          reason: 'Cancelled due to previous permission denial',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
        });
        this.pendingRequests.delete(requestId);
        cancelledCount++;
      }
    }

    if (cancelledCount > 0) {
      console.log(
        `🛡️  [executor] Cancelled ${cancelledCount} pending permission request(s) for session ${sessionId.substring(0, 8)}`
      );
    }
  }
}
