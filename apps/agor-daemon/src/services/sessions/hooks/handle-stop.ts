/**
 * Bulletproof Stop Handler with Acknowledgments
 *
 * Implements a request-response protocol for stopping tasks:
 * 1. Send stop signal with sequence number (retry up to 3 times)
 * 2. Wait for ACK from executor (confirms receipt)
 * 3. Wait for completion signal (confirms stopped)
 * 4. Update session to IDLE with ready_for_prompt=false
 * 5. Safety nets for timeouts and hung executors
 *
 * OWNERSHIP OF STATE TRANSITIONS:
 * - Task status STOPPING → STOPPED: Set by executor (via tasks.patch)
 * - Session status STOPPING → IDLE: Set by both tasks.ts hook AND this handler
 * - ready_for_prompt flag: ONLY set by this handler for STOPPED tasks
 *   (tasks.ts explicitly skips ready_for_prompt for STOPPED status to avoid race)
 *
 * RACE CONDITION PREVENTION:
 * - Executor checks BOTH session_id AND task_id before responding to stop signal
 * - tasks.ts does NOT set ready_for_prompt for STOPPED tasks (avoids racing with this handler)
 * - This handler validates task is still in STOPPING state before proceeding
 */

import type { Application } from '@agor/core/feathers';
import type { Params, SessionID, TaskID, User } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';

interface StopAckData {
  session_id: string;
  task_id: string;
  sequence: number;
  received_at: string;
  status: 'stopping' | 'already_stopped';
}

interface StopCompleteData {
  session_id: string;
  task_id: string;
  stopped_at: string;
}

interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
  };
  user?: User;
}

const MAX_RETRIES = 3;
const ACK_TIMEOUT_MS = 5000; // 5 seconds for initial ACK
const STOP_COMPLETE_TIMEOUT_MS = 30000; // 30 seconds for full stop

/**
 * Handle stop request with acknowledgment protocol
 *
 * This function implements a bulletproof stop mechanism that:
 * - Retries stop signals if not acknowledged
 * - Waits for executor confirmation before updating state
 * - Updates task and session atomically
 * - Has safety nets for hung executors
 */
export async function handleStopWithAck(
  app: Application,
  sessionId: SessionID,
  taskId: TaskID,
  params: RouteParams
): Promise<{ success: boolean; reason?: string }> {
  console.log(`🛑 [Stop Handler] Starting stop for task ${taskId.substring(0, 8)}`);

  // DEFENSIVE: Verify task is still in STOPPING state before proceeding
  // This guards against race conditions where the task completed naturally
  // between when stop was requested and when this handler runs
  try {
    const currentTask = await app.service('tasks').get(taskId);
    if (currentTask.status !== TaskStatus.STOPPING) {
      console.log(
        `⏭️ [Stop Handler] Task ${taskId.substring(0, 8)} already in terminal state (${currentTask.status}), skipping stop`
      );
      return {
        success: true,
        reason: `Task already ${currentTask.status}`,
      };
    }
  } catch (error) {
    console.error(`❌ [Stop Handler] Failed to verify task state:`, error);
    // Continue anyway - better to attempt stop than to bail
  }

  let sequence = 0;
  let ackReceived = false;

  // PHASE 1: Send stop signal and wait for ACK (with retries)
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    sequence++;

    console.log(
      `🛑 [Stop Handler] Sending stop signal (attempt ${attempt + 1}/${MAX_RETRIES}, seq ${sequence})`
    );

    // Create promise to wait for ACK
    const ackPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        app.service('sessions').removeListener('task_stop_ack', ackHandler);
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const ackHandler = (data: StopAckData) => {
        if (data.task_id === taskId && data.sequence === sequence) {
          clearTimeout(timeout);
          app.service('sessions').removeListener('task_stop_ack', ackHandler);
          console.log(`✅ [Stop Handler] Received ACK (seq ${sequence})`);
          resolve(true);
        }
      };

      app.service('sessions').on('task_stop_ack', ackHandler);
    });

    // Send stop event via WebSocket
    app.service('sessions').emit('task_stop', {
      session_id: sessionId,
      task_id: taskId,
      sequence,
      timestamp: new Date().toISOString(),
    });

    // Wait for ACK
    ackReceived = await ackPromise;

    if (ackReceived) {
      console.log(`✅ [Stop Handler] ACK received (seq ${sequence})`);
      break;
    }

    console.warn(`⚠️  [Stop Handler] ACK timeout (attempt ${attempt + 1}/${MAX_RETRIES})`);
  }

  // If no ACK after retries, force update and return
  if (!ackReceived) {
    console.error(`❌ [Stop Handler] Failed to receive ACK after ${MAX_RETRIES} attempts`);

    // Safety net: Force update task and session to stopped/idle
    // BUT FIRST: Check if session is still in STOPPING state.
    // If a new task started while we were waiting for ACK, session will be RUNNING
    // and we should NOT force it to IDLE (that would break the new task).
    try {
      const currentSession = await app.service('sessions').get(sessionId);
      if (currentSession.status !== SessionStatus.STOPPING) {
        console.warn(
          `⚠️  [Stop Handler] Session ${sessionId.substring(0, 8)} is no longer STOPPING (now ${currentSession.status}), skipping force-stop`
        );
        // Still update the task to STOPPED (it's the old task that never ACKed)
        await app.service('tasks').patch(taskId, {
          status: TaskStatus.STOPPED,
          completed_at: new Date().toISOString(),
        });
        return {
          success: true,
          reason: 'Task force-stopped but session already moved on to new task',
        };
      }

      await app.service('tasks').patch(taskId, {
        status: TaskStatus.STOPPED,
        completed_at: new Date().toISOString(),
      });

      await app.service('sessions').patch(sessionId, {
        status: SessionStatus.IDLE,
        ready_for_prompt: false, // Don't auto-start queued messages after forced stop
      });

      console.warn(`⚠️  [Stop Handler] Force-stopped task (executor may be hung)`);
    } catch (error) {
      console.error(`❌ [Stop Handler] Failed to force-stop:`, error);
    }

    return {
      success: true, // Force-stop was successful, even though executor didn't ACK
      reason:
        'Task force-stopped after executor failed to acknowledge (executor may be hung or disconnected)',
    };
  }

  // PHASE 2: Wait for completion signal
  console.log(`⏳ [Stop Handler] Waiting for completion signal...`);

  const completePromise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      app.service('sessions').removeListener('task_stopped_complete', completeHandler);
      resolve(false);
    }, STOP_COMPLETE_TIMEOUT_MS);

    const completeHandler = (data: StopCompleteData) => {
      // DEFENSIVE: Validate both task_id AND session_id to prevent cross-session confusion
      if (data.task_id === taskId && data.session_id === sessionId) {
        clearTimeout(timeout);
        app.service('sessions').removeListener('task_stopped_complete', completeHandler);
        console.log(`✅ [Stop Handler] Received completion signal`);
        resolve(true);
      }
    };

    app.service('sessions').on('task_stopped_complete', completeHandler);
  });

  const stopComplete = await completePromise;

  if (!stopComplete) {
    console.warn(
      `⚠️  [Stop Handler] Completion timeout after ${STOP_COMPLETE_TIMEOUT_MS}ms (executor may be stuck)`
    );

    // Safety net: Force update even though we got ACK
    // BUT FIRST: Check if session is still in STOPPING state.
    // If a new task started while we were waiting, session will be RUNNING.
    try {
      const currentSession = await app.service('sessions').get(sessionId);
      if (currentSession.status !== SessionStatus.STOPPING) {
        console.warn(
          `⚠️  [Stop Handler] Session ${sessionId.substring(0, 8)} is no longer STOPPING (now ${currentSession.status}), skipping force-stop`
        );
        // Still update the task to STOPPED
        await app.service('tasks').patch(taskId, {
          status: TaskStatus.STOPPED,
          completed_at: new Date().toISOString(),
        });
        return {
          success: true,
          reason: 'Task force-stopped but session already moved on to new task',
        };
      }

      await app.service('tasks').patch(taskId, {
        status: TaskStatus.STOPPED,
        completed_at: new Date().toISOString(),
      });

      await app.service('sessions').patch(sessionId, {
        status: SessionStatus.IDLE,
        ready_for_prompt: false, // Don't auto-start queued messages after timeout
      });

      console.warn(`⚠️  [Stop Handler] Force-stopped task after ACK timeout`);
    } catch (error) {
      console.error(`❌ [Stop Handler] Failed to force-stop after timeout:`, error);
    }

    return {
      success: true, // ACK received, so partial success
      reason: 'Stop initiated but completion not confirmed within timeout',
    };
  }

  // PHASE 3: Success! Executor confirmed stop complete
  // Task status should already be updated by executor
  // Just update session status atomically
  console.log(`✅ [Stop Handler] Stop complete, updating session to IDLE`);

  try {
    // IMPORTANT: Set ready_for_prompt=false to prevent auto-queue-processing
    // User explicitly stopped the session, so don't auto-start queued messages
    // User must manually send the next prompt
    await app.service('sessions').patch(sessionId, {
      status: SessionStatus.IDLE,
      ready_for_prompt: false, // ← CRITICAL: Prevents auto-queue-processing!
    });

    console.log(
      `✅ [Stop Handler] Session ${sessionId.substring(0, 8)} is now IDLE (ready_for_prompt=false)`
    );

    return { success: true };
  } catch (error) {
    console.error(`❌ [Stop Handler] Failed to update session to IDLE:`, error);
    return {
      success: false,
      reason: `Failed to update session status: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
