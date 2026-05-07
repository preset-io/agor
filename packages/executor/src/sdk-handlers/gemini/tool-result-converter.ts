import type { Gemini, GenAI } from '@agor/core/sdk';

type Part = GenAI.Part;

/**
 * Convert a single completed Scheduler tool call into the Gemini function-response
 * `Part`(s) we need to feed back to the model.
 *
 * Pulled out of the streaming loop so the migrated Scheduler path
 * (`Gemini.Scheduler` with `context: config` in cli-core 0.41+) has a
 * unit-testable seam — the conversion shape is what callers downstream
 * actually depend on.
 *
 * Behavior:
 * - If the SDK populated `response.responseParts`, pass them through verbatim.
 * - Otherwise emit a single error/no-response `functionResponse` part keyed by
 *   the tool name, so the model still gets a turn-correlated reply.
 */
export function completedCallToResponseParts(completedCall: Gemini.CompletedToolCall): Part[] {
  try {
    const responseParts = completedCall.response?.responseParts;
    if (responseParts && responseParts.length > 0) {
      return [...responseParts];
    }

    return [
      {
        functionResponse: {
          name: completedCall.request.name,
          response: {
            error:
              completedCall.status === 'error'
                ? completedCall.response?.error?.message || 'Tool execution failed'
                : 'Tool execution returned no response',
          },
        },
      } as Part,
    ];
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return [
      {
        functionResponse: {
          name: completedCall.request.name,
          response: { error: errorMessage },
        },
      } as Part,
    ];
  }
}

/**
 * Convert a batch of completed Scheduler tool calls into a flat `Part[]`
 * suitable for sending back to Gemini as the next user turn.
 */
export function completedCallsToResponseParts(
  completedCalls: readonly Gemini.CompletedToolCall[]
): Part[] {
  return completedCalls.flatMap(completedCallToResponseParts);
}
