import { describe, expect, it, vi } from 'vitest';
import type { CopilotSessionEvents } from './event-mapper.js';
import { observeCopilotToolEvents } from './event-mapper.js';

describe('observeCopilotToolEvents', () => {
  it('reports native tool start and finish with the normalized label', () => {
    const handlers = new Map<string, (event: never) => void>();
    const session = {
      on: vi.fn((event: string, handler: (event: never) => void) => handlers.set(event, handler)),
    } as unknown as CopilotSessionEvents;
    const runtime = { pulse: vi.fn() };
    const onStart = vi.fn();
    const onComplete = vi.fn();

    observeCopilotToolEvents(session, { runtime, onStart, onComplete });
    handlers.get('tool.execution_start')?.({
      data: {
        toolCallId: 'call-1',
        toolName: 'fallback',
        mcpServerName: 'server',
        mcpToolName: 'read',
      },
    } as never);
    handlers.get('tool.execution_complete')?.({
      data: {
        toolCallId: 'call-1',
        toolName: 'fallback',
        mcpServerName: 'server',
        mcpToolName: 'read',
        status: 'error',
      },
    } as never);

    expect(runtime.pulse).toHaveBeenNthCalledWith(1, {
      kind: 'tool.started',
      id: 'call-1',
      label: 'server.read',
    });
    expect(runtime.pulse).toHaveBeenNthCalledWith(2, {
      kind: 'tool.finished',
      id: 'call-1',
      label: 'server.read',
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
