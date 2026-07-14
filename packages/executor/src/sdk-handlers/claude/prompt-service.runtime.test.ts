import { describe, expect, it, vi } from 'vitest';
import { pulseClaudeToolProgress } from './runtime-progress.js';

describe('Claude runtime progress', () => {
  it('keeps noisy tool progress out of the UI while recording bounded runtime activity', () => {
    const runtime = { pulse: vi.fn() };

    pulseClaudeToolProgress(
      {
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        elapsed_time_seconds: 30,
        raw_output: 'private output',
      },
      runtime
    );

    expect(runtime.pulse).toHaveBeenCalledWith({
      kind: 'tool.progress',
      id: 'tool-1',
      label: 'Bash',
    });
  });

  it('ignores non-progress messages', () => {
    const runtime = { pulse: vi.fn() };

    pulseClaudeToolProgress({ type: 'assistant', message: 'private' }, runtime);

    expect(runtime.pulse).not.toHaveBeenCalled();
  });
});
