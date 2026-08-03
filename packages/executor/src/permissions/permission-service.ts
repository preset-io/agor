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

import { resolvePermissionTimeoutMs } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope, PermissionStatus } from '@agor/core/types';
import type { InteractionMode, ResolvedConfigSlice } from '../payload-types.js';
import type { SdkActivityCallback } from '../sdk-watchdog.js';
import type { AgorClient } from '../services/feathers-client.js';

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
}

type PermissionResolutionBase = Omit<PermissionDecision, 'allow'>;
export type PermissionResolution =
  | (PermissionResolutionBase & { outcome: 'approved' })
  | (PermissionResolutionBase & { outcome: 'denied' })
  | (PermissionResolutionBase & { outcome: 'cancelled' })
  | (PermissionResolutionBase & { outcome: 'timed_out' })
  | (PermissionResolutionBase & { outcome: 'unavailable' });

export function getPermissionStatus(resolution: PermissionResolution): PermissionStatus {
  switch (resolution.outcome) {
    case 'approved':
      return PermissionStatus.APPROVED;
    case 'timed_out':
      return PermissionStatus.TIMED_OUT;
    case 'denied':
    case 'cancelled':
    case 'unavailable':
      return PermissionStatus.DENIED;
  }
}

// Re-export for convenience
export { PermissionScope };

const PermissionEvent = {
  REQUEST: 'permission:request',
  TIMEOUT: 'permission:timeout',
} as const;
type PermissionEvent = (typeof PermissionEvent)[keyof typeof PermissionEvent];

/**
 * Executor version of PermissionService
 * Emits events via IPC to daemon instead of directly via WebSocket
 */
export class PermissionService {
  private readonly timeoutMs: number;
  private pendingRequests = new Map<
    string,
    {
      sessionId: SessionID;
      resolve: (resolution: PermissionResolution) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  /**
   * @param emitEvent - Function to emit events via IPC to daemon
   * @param timeoutMs - Permission request timeout in ms (default: 10 minutes)
   */
  constructor(
    private emitEvent: (event: PermissionEvent, data: unknown) => Promise<void>,
    timeoutMs?: number,
    private interactionMode: InteractionMode = 'interactive',
    private onActivity?: SdkActivityCallback
  ) {
    this.timeoutMs = resolvePermissionTimeoutMs({ permission_timeout_ms: timeoutMs });
  }

  /**
   * Emit a permission request event to daemon (which broadcasts via WebSocket)
   */
  async emitRequest(sessionId: SessionID, request: Omit<PermissionRequest, 'sessionId'>) {
    const fullRequest: PermissionRequest = { ...request, sessionId };
    await this.emitEvent(PermissionEvent.REQUEST, fullRequest);
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
  ): Promise<PermissionResolution> {
    if (signal.aborted) {
      return Promise.resolve({
        requestId,
        taskId,
        outcome: 'cancelled',
        reason: 'Cancelled',
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'system',
      });
    }

    if (this.interactionMode === 'unattended') {
      return Promise.resolve({
        requestId,
        taskId,
        outcome: 'unavailable',
        reason: 'This execution surface cannot answer permission requests',
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'system',
      });
    }

    this.onActivity?.({
      type: 'waiting_started',
      id: requestId,
      reason: 'permission',
      absoluteTimeoutMs: this.timeoutMs,
    });

    return new Promise((resolve) => {
      // Handle cancellation
      signal.addEventListener('abort', () => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(requestId);
        }
        this.onActivity?.({ type: 'waiting_finished', id: requestId, outcome: 'cancelled' });
        console.log(`🛡️  [executor] Permission request cancelled: ${requestId}`);
        resolve({
          requestId,
          taskId,
          outcome: 'cancelled',
          reason: 'Cancelled',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
        });
      });

      // Timeout (configurable, default 10 minutes)
      const timeout = setTimeout(async () => {
        this.pendingRequests.delete(requestId);
        this.onActivity?.({ type: 'waiting_finished', id: requestId, outcome: 'timed_out' });
        console.warn(`⏰ [executor] Permission request timed out: ${requestId}`);

        // Broadcast timeout to UI via daemon
        try {
          await this.emitEvent(PermissionEvent.TIMEOUT, { requestId, sessionId, taskId });
        } catch (err) {
          console.error(`⚠️  [executor] Failed to emit permission:timeout event:`, err);
        }

        resolve({
          requestId,
          taskId,
          outcome: 'timed_out',
          reason: 'Timed out',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
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
      const { allow, ...resolution } = decision;
      pending.resolve({
        ...resolution,
        outcome: allow ? 'approved' : 'denied',
      });
      this.pendingRequests.delete(decision.requestId);
      this.onActivity?.({
        type: 'waiting_finished',
        id: decision.requestId,
        outcome: allow ? 'approved' : 'denied',
      });
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
          outcome: 'cancelled',
          reason: 'Cancelled due to previous permission denial',
          remember: false,
          scope: PermissionScope.ONCE,
          decidedBy: 'system',
        });
        this.pendingRequests.delete(requestId);
        this.onActivity?.({ type: 'waiting_finished', id: requestId, outcome: 'cancelled' });
        cancelledCount++;
      }
    }

    if (cancelledCount > 0) {
      console.log(
        `🛡️  [executor] Cancelled ${cancelledCount} pending permission request(s) for session ${shortId(sessionId)}`
      );
    }
  }
}

export function createExecutionPermissionService(params: {
  client: AgorClient;
  resolvedConfig?: ResolvedConfigSlice;
  interactionMode?: InteractionMode;
  onActivity?: SdkActivityCallback;
}): PermissionService {
  return new PermissionService(
    async (event, data) => params.client.service('sessions').emit(event, data),
    params.resolvedConfig?.execution?.permission_timeout_ms,
    params.interactionMode,
    params.onActivity
  );
}
