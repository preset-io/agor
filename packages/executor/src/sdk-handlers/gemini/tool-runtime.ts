import { PULSE_KIND } from '@agor/core/types';
import type { AgenticToolRuntime } from '../../runtime-overseer.js';

interface GeminiToolRequest {
  callId: string;
  name: string;
}

interface GeminiCompletedToolCall {
  request: GeminiToolRequest;
}

export async function scheduleGeminiTools<T extends GeminiCompletedToolCall>(
  requests: readonly GeminiToolRequest[],
  schedule: () => Promise<T[]>,
  runtime?: AgenticToolRuntime
): Promise<T[]> {
  for (const request of requests) {
    runtime?.pulse({ kind: PULSE_KIND.TOOL_STARTED, id: request.callId, label: request.name });
  }

  const completedCalls = await schedule();

  for (const completedCall of completedCalls) {
    const { callId, name } = completedCall.request;
    runtime?.pulse({ kind: PULSE_KIND.TOOL_FINISHED, id: callId, label: name });
  }

  return completedCalls;
}
