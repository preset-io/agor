import { describe, expect, it, vi } from 'vitest';
import { scheduleGeminiTools } from './tool-runtime.js';

describe('scheduleGeminiTools', () => {
  it('reports native tool start and finish around the scheduler', async () => {
    const runtime = { pulse: vi.fn() };
    const requests = [{ callId: 'call-1', name: 'read_file' }];
    const completedCalls = [{ request: requests[0], status: 'success' }];

    await expect(
      scheduleGeminiTools(requests, vi.fn().mockResolvedValue(completedCalls), runtime)
    ).resolves.toBe(completedCalls);

    expect(runtime.pulse).toHaveBeenNthCalledWith(1, {
      kind: 'tool.started',
      id: 'call-1',
      label: 'read_file',
    });
    expect(runtime.pulse).toHaveBeenNthCalledWith(2, {
      kind: 'tool.finished',
      id: 'call-1',
      label: 'read_file',
    });
  });

  it('keeps the start pulse when the scheduler fails', async () => {
    const runtime = { pulse: vi.fn() };
    const error = new Error('scheduler failed');

    await expect(
      scheduleGeminiTools(
        [{ callId: 'call-1', name: 'read_file' }],
        vi.fn().mockRejectedValue(error),
        runtime
      )
    ).rejects.toBe(error);

    expect(runtime.pulse).toHaveBeenCalledExactlyOnceWith({
      kind: 'tool.started',
      id: 'call-1',
      label: 'read_file',
    });
  });
});
