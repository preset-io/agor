/**
 * Input Request Service (Executor Version)
 *
 * Handles async input requests from Claude Agent SDK's AskUserQuestion tool.
 * Emits events via Feathers WebSocket to daemon for broadcasting to UI clients.
 *
 * ## Flow in Feathers/WebSocket Architecture:
 *
 * 1. canUseTool intercepts AskUserQuestion → InputRequestService.emitRequest()
 * 2. Event sent via Feathers WebSocket to daemon → Daemon broadcasts to UI clients
 * 3. Task/session updated via Feathers client (awaiting_input)
 * 4. InputRequestService.waitForResponse() creates Promise that pauses SDK
 * 5. UI answers → daemon receives answers → WebSocket notification to executor
 * 6. Executor receives input_resolved event → calls InputRequestService.resolveInput()
 * 7. Promise resolves → SDK resumes with answers via updatedInput
 */

import type { SessionID, TaskID } from '@agor/core/types';

export interface InputRequest {
  requestId: string;
  sessionId: SessionID;
  taskId: TaskID;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; markdown?: string }>;
    multiSelect: boolean;
  }>;
  timestamp: string;
}

export interface InputResponse {
  requestId: string;
  taskId: TaskID;
  answers: Record<string, string>;
  annotations?: Record<string, { markdown?: string; notes?: string }>;
  respondedBy: string;
}

/** Timeout for input requests: 5 minutes (users need time to read and answer) */
const INPUT_REQUEST_TIMEOUT_MS = 300000;

/**
 * Executor version of InputRequestService
 * Emits events via IPC to daemon instead of directly via WebSocket
 */
export class InputRequestService {
  private pendingRequests = new Map<
    string,
    {
      sessionId: SessionID;
      resolve: (response: InputResponse) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  /**
   * @param emitEvent - Function to emit events via IPC to daemon
   */
  constructor(private emitEvent: (event: string, data: unknown) => Promise<void>) {}

  /**
   * Emit an input request event to daemon (which broadcasts via WebSocket)
   */
  async emitRequest(sessionId: SessionID, request: Omit<InputRequest, 'sessionId'>) {
    const fullRequest: InputRequest = { ...request, sessionId };
    await this.emitEvent('input:request', fullRequest);
    console.log(
      `❓ [executor] Input request emitted via IPC: ${request.questions.length} question(s) for task ${request.taskId}`
    );
  }

  /**
   * Wait for an input response from daemon
   * Returns a Promise that pauses SDK execution until resolved
   */
  waitForResponse(
    requestId: string,
    taskId: TaskID,
    sessionId: SessionID,
    signal: AbortSignal
  ): Promise<InputResponse> {
    return new Promise((resolve) => {
      // Handle cancellation
      signal.addEventListener('abort', () => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(requestId);
        }
        console.log(`❓ [executor] Input request cancelled: ${requestId}`);
        resolve({
          requestId,
          taskId,
          answers: {},
          respondedBy: 'system',
        });
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn(`⚠️  [executor] Input request timeout: ${requestId}`);
        resolve({
          requestId,
          taskId,
          answers: {},
          respondedBy: 'system',
        });
      }, INPUT_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { sessionId, resolve, timeout });
      console.log(`❓ [executor] Waiting for input response: ${requestId}`);
    });
  }

  /**
   * Resolve a pending input request
   * Called by IPC handler when daemon sends input_resolved notification
   */
  resolveInput(response: InputResponse) {
    const pending = this.pendingRequests.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(response);
      this.pendingRequests.delete(response.requestId);
      console.log(
        `❓ [executor] Input resolved: ${response.requestId} → answered by ${response.respondedBy}`
      );
    } else {
      console.warn(`⚠️  [executor] No pending input request found for ${response.requestId}`);
    }
  }

  /**
   * Cancel all pending input requests for a session
   */
  cancelPendingRequests(sessionId: SessionID) {
    let cancelledCount = 0;

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.resolve({
          requestId,
          taskId: '' as TaskID,
          answers: {},
          respondedBy: 'system',
        });
        this.pendingRequests.delete(requestId);
        cancelledCount++;
      }
    }

    if (cancelledCount > 0) {
      console.log(
        `❓ [executor] Cancelled ${cancelledCount} pending input request(s) for session ${sessionId.substring(0, 8)}`
      );
    }
  }
}
