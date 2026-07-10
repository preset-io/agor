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
    runtime?.pulse({ kind: 'tool.started', id: request.callId, label: request.name });
  }

  const completedCalls = await schedule();

  for (const completedCall of completedCalls) {
    const { callId, name } = completedCall.request;
    runtime?.pulse({ kind: 'tool.finished', id: callId, label: name });
  }

  return completedCalls;
}
