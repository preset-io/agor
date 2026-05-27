import { describe, expect, it, vi } from 'vitest';
import { buildAssistantMessageMetadata, patchTaskModelIfKnown } from './model-recording.js';

describe('buildAssistantMessageMetadata', () => {
  it('omits the model key when unknown', () => {
    const metadata = buildAssistantMessageMetadata({ model: undefined });
    expect(metadata).not.toHaveProperty('model');
    expect(metadata.tokens).toEqual({ input: 0, output: 0 });
  });

  it('omits the model key for an empty string', () => {
    expect(buildAssistantMessageMetadata({ model: '' })).not.toHaveProperty('model');
  });

  it('records the model when present', () => {
    expect(buildAssistantMessageMetadata({ model: 'gpt-5.5' }).model).toBe('gpt-5.5');
  });

  it('records token usage', () => {
    const metadata = buildAssistantMessageMetadata({
      model: 'gpt-5.5',
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(metadata.tokens).toEqual({ input: 100, output: 50 });
  });
});

describe('patchTaskModelIfKnown', () => {
  function service() {
    return { get: vi.fn(), patch: vi.fn().mockResolvedValue({}), emit: vi.fn() };
  }

  it('patches when all inputs are present', async () => {
    const s = service();
    await patchTaskModelIfKnown(s, 'task-1', 'gpt-5.5');
    expect(s.patch).toHaveBeenCalledWith('task-1', { model: 'gpt-5.5' });
  });

  it.each([
    ['undefined model', 'task-1', undefined],
    ['empty model', 'task-1', ''],
    ['missing taskId', undefined, 'gpt-5.5'],
  ])('no-ops with %s', async (_label, taskId, model) => {
    const s = service();
    await patchTaskModelIfKnown(s, taskId, model);
    expect(s.patch).not.toHaveBeenCalled();
  });

  it('no-ops with no service', async () => {
    await expect(patchTaskModelIfKnown(undefined, 'task-1', 'gpt-5.5')).resolves.toBeUndefined();
  });
});
