import type { Gemini, GenAI } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';

type Part = GenAI.Part;

import {
  completedCallsToResponseParts,
  completedCallToResponseParts,
} from './tool-result-converter.js';

/**
 * Build a minimal `CompletedToolCall`-shaped object for tests.
 *
 * `CompletedToolCall` is a discriminated union with several mandatory fields
 * (`tool`, `invocation`, etc.) that the converter never reads. We only set the
 * fields the converter actually touches and cast to the public type — this
 * keeps the test honest about its surface and avoids over-mocking the SDK.
 */
function makeCompletedCall(
  partial: {
    name?: string;
    status?: 'success' | 'error' | 'cancelled';
    responseParts?: Part[];
    errorMessage?: string;
  } = {}
): Gemini.CompletedToolCall {
  const { name = 'tool_x', status = 'success', responseParts, errorMessage } = partial;
  return {
    status,
    request: { callId: 'call-1', name, args: {}, isClientInitiated: false, prompt_id: 'p1' },
    response: {
      callId: 'call-1',
      responseParts,
      error: errorMessage ? new Error(errorMessage) : undefined,
    },
  } as unknown as Gemini.CompletedToolCall;
}

describe('completedCallToResponseParts', () => {
  it('passes through SDK-supplied response parts verbatim', () => {
    const parts: Part[] = [
      { functionResponse: { name: 'fs_read', response: { content: 'hello' } } } as Part,
    ];
    const result = completedCallToResponseParts(
      makeCompletedCall({ name: 'fs_read', responseParts: parts })
    );
    expect(result).toEqual(parts);
    // returns a fresh array (caller may mutate downstream)
    expect(result).not.toBe(parts);
  });

  it('emits a "no response" error part when responseParts is missing', () => {
    const result = completedCallToResponseParts(
      makeCompletedCall({ name: 'shell', status: 'success', responseParts: undefined })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      functionResponse: {
        name: 'shell',
        response: { error: 'Tool execution returned no response' },
      },
    });
  });

  it('emits a "no response" error part when responseParts is empty', () => {
    const result = completedCallToResponseParts(
      makeCompletedCall({ name: 'shell', responseParts: [] })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      functionResponse: {
        name: 'shell',
        response: { error: 'Tool execution returned no response' },
      },
    });
  });

  it('uses the SDK error message when status=error and responseParts is missing', () => {
    const result = completedCallToResponseParts(
      makeCompletedCall({
        name: 'shell',
        status: 'error',
        errorMessage: 'permission denied',
      })
    );
    expect(result).toEqual([
      {
        functionResponse: {
          name: 'shell',
          response: { error: 'permission denied' },
        },
      },
    ]);
  });

  it('falls back to "Tool execution failed" when status=error but no error message', () => {
    const result = completedCallToResponseParts(
      makeCompletedCall({ name: 'shell', status: 'error' })
    );
    expect(result[0]).toMatchObject({
      functionResponse: { name: 'shell', response: { error: 'Tool execution failed' } },
    });
  });
});

describe('completedCallsToResponseParts', () => {
  it('flattens batched completed calls into a single Part[]', () => {
    const okParts: Part[] = [
      { functionResponse: { name: 'a', response: { ok: true } } } as Part,
      { functionResponse: { name: 'a', response: { trailing: 'meta' } } } as Part,
    ];
    const result = completedCallsToResponseParts([
      makeCompletedCall({ name: 'a', responseParts: okParts }),
      makeCompletedCall({ name: 'b', status: 'error', errorMessage: 'boom' }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(okParts[0]);
    expect(result[1]).toEqual(okParts[1]);
    expect(result[2]).toMatchObject({
      functionResponse: { name: 'b', response: { error: 'boom' } },
    });
  });

  it('returns an empty array when the input is empty', () => {
    expect(completedCallsToResponseParts([])).toEqual([]);
  });

  it('preserves order across calls', () => {
    const parts1: Part[] = [{ functionResponse: { name: 'first', response: {} } } as Part];
    const parts2: Part[] = [{ functionResponse: { name: 'second', response: {} } } as Part];
    const result = completedCallsToResponseParts([
      makeCompletedCall({ name: 'first', responseParts: parts1 }),
      makeCompletedCall({ name: 'second', responseParts: parts2 }),
    ]);
    expect(result.map((p) => p.functionResponse?.name)).toEqual(['first', 'second']);
  });
});
