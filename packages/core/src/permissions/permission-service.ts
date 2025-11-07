/**
 * Permission Service
 *
 * Handles async permission requests from Claude Agent SDK PreToolUse hooks.
 * Enables UI-based permission prompts that pause SDK execution until user decides.
 *
 * ## Multi-User Architecture
 *
 * Permission requests are stored **at the task level**, not globally:
 * - Task status becomes 'awaiting_permission'
 * - Task stores the permission_request payload
 * - ANY user viewing the session can approve/deny
 * - Approval is logged with userId for audit trail
 *
 * ## Flow
 *
 * 1. PreToolUse hook fires → PermissionService.emitRequest()
 * 2. Task is updated: status='awaiting_permission', permission_request={...}
 * 3. UI shows inline permission prompt under last message
 * 4. ANY user clicks approve/deny → PermissionService.resolvePermission()
 * 5. Task updated: status='running', permission_request.approved_by=userId
 * 6. SDK resumes execution
 *
 * ## WebSocket Broadcasting
 *
 * Permission requests broadcast to ALL clients viewing the session:
 * - Event: 'permission:request' with taskId
 * - UI renders prompt inline in conversation
 * - First user to decide resolves for everyone
 */

import type { SessionID, TaskID } from '../types';

export interface PermissionRequest {
  requestId: string;
  sessionId: SessionID;
  taskId: TaskID; // Task waiting for permission
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  timestamp: string;
}

// NOTE: PermissionScope is now defined as an enum in types/message.ts
// Import it from there instead of using this type union
import { PermissionScope } from '../types/message';

export interface PermissionDecision {
  requestId: string;
  taskId: TaskID; // Task to resume
  allow: boolean;
  reason?: string;
  remember: boolean;
  scope: PermissionScope; // 'once' = don't save, 'session' = db, 'project' = .claude/settings.json
  // Multi-user: Who made the decision?
  decidedBy: string; // userId
}

export class PermissionService {
  private pendingRequests = new Map<
    string,
    {
      sessionId: SessionID;
      resolve: (decision: PermissionDecision) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private emitEvent: (event: string, data: unknown) => void) {}

  /**
   * Emit a permission request event to the UI
   * Broadcasts to ALL connected clients viewing this session
   *
   * @param sessionId - Session containing the task
   * @param request - Permission request details (includes taskId)
   */
  emitRequest(sessionId: SessionID, request: Omit<PermissionRequest, 'sessionId'>) {
    const fullRequest: PermissionRequest = { ...request, sessionId };
    this.emitEvent('permission:request', fullRequest);
    console.log(
      `🛡️  Permission request emitted: ${request.toolName} for task ${request.taskId} (${request.requestId})`
    );
  }

  /**
   * Wait for a permission decision from the UI
   * Returns a Promise that pauses SDK execution until resolved
   *
   * @param requestId - Unique permission request ID
   * @param taskId - Task waiting for permission (used for timeout/cancel fallback)
   * @param sessionId - Session ID for tracking pending requests per session
   * @param signal - AbortSignal for cancellation
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
        console.log(`🛡️  Permission request cancelled: ${requestId}`);
        resolve({
          requestId,
          taskId,
          allow: false,
          reason: 'Cancelled',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system', // System-initiated cancel
        });
      });

      // Timeout after 60 seconds (fail-safe)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn(`⚠️  Permission request timeout: ${requestId}`);
        resolve({
          requestId,
          taskId,
          allow: false,
          reason: 'Timeout',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system', // System-initiated timeout
        });
      }, 60000);

      this.pendingRequests.set(requestId, { sessionId, resolve, timeout });
    });
  }

  /**
   * Resolve a pending permission request with a decision from the UI
   */
  resolvePermission(decision: PermissionDecision) {
    const pending = this.pendingRequests.get(decision.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(decision);
      this.pendingRequests.delete(decision.requestId);
      console.log(
        `🛡️  Permission resolved: ${decision.requestId} → ${decision.allow ? 'ALLOW' : 'DENY'}`
      );
    } else {
      console.warn(`⚠️  No pending request found for ${decision.requestId}`);
    }
  }

  /**
   * Cancel all pending permission requests for a session
   * Used when a permission is denied and we need to stop task execution
   *
   * @param sessionId - Session to cancel pending requests for
   */
  cancelPendingRequests(sessionId: SessionID) {
    let cancelledCount = 0;

    // Iterate through all pending requests and cancel those for this session
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      // Only cancel requests for the specified session
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.resolve({
          requestId,
          taskId: '' as TaskID, // Will be ignored since we're cancelling
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
        `🛡️  Cancelled ${cancelledCount} pending permission request(s) for session ${sessionId.substring(0, 8)}`
      );
    }
  }
}
