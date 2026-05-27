import { describe, expect, it, vi } from 'vitest';
import {
  buildAssistantMessageMetadata,
  patchTaskModelIfKnown,
  resolveTaskModelFromResult,
} from './model-recording.js';

describe('resolveTaskModelFromResult', () => {
  // Regression: user selected GPT 5.5 in session settings; before the fix
  // the Codex normalizer's hardcoded primaryModel ("gpt-5.4") was clobbering
  // the resolved model on every task patch. resultModel is the source of
  // truth — it carries session.model_config.model end-to-end.
  it('prefers the tool-reported model over the normalizer-derived one', () => {
    expect(
      resolveTaskModelFromResult({
        resultModel: 'gpt-5.5',
        normalizedPrimaryModel: 'gpt-5.4',
      })
    ).toBe('gpt-5.5');
  });

  // Codex/Gemini path: their normalizers intentionally leave primaryModel
  // undefined because the raw SDK event doesn't echo the model.
  it('returns the tool-reported model when normalizer omits one', () => {
    expect(
      resolveTaskModelFromResult({
        resultModel: 'gpt-5.5',
        normalizedPrimaryModel: undefined,
      })
    ).toBe('gpt-5.5');
  });

  // Claude/Copilot path: SDK event carries the model; tool may also report
  // one. Either way, the agreed model is returned.
  it('falls back to normalizer-derived model when tool result omits one', () => {
    expect(
      resolveTaskModelFromResult({
        resultModel: undefined,
        normalizedPrimaryModel: 'claude-sonnet-4-5-20250929',
      })
    ).toBe('claude-sonnet-4-5-20250929');
  });

  // Legacy path / pre-normalization tasks: neither source has a model.
  // Caller should leave Task.model untouched rather than writing "".
  it('returns undefined when neither source has a model', () => {
    expect(
      resolveTaskModelFromResult({ resultModel: undefined, normalizedPrimaryModel: undefined })
    ).toBeUndefined();
  });

  // Empty strings count as missing (truthy guard); avoid clobbering with "".
  it('treats empty strings as missing values', () => {
    expect(
      resolveTaskModelFromResult({ resultModel: '', normalizedPrimaryModel: '' })
    ).toBeUndefined();
    expect(resolveTaskModelFromResult({ resultModel: '', normalizedPrimaryModel: 'gpt-5.4' })).toBe(
      'gpt-5.4'
    );
  });
});

describe('buildAssistantMessageMetadata', () => {
  it('omits model entirely when unknown rather than writing undefined', () => {
    // Contract: the key should be absent — not present with value undefined.
    // Tightens up the "honest record" invariant; would also pass under
    // exactOptionalPropertyTypes if we ever flip the tsconfig flag.
    const metadata = buildAssistantMessageMetadata({ model: undefined });
    expect(metadata).not.toHaveProperty('model');
    expect(metadata.tokens).toEqual({ input: 0, output: 0 });
  });

  it('includes model when known', () => {
    const metadata = buildAssistantMessageMetadata({ model: 'gpt-5.5' });
    expect(metadata.model).toBe('gpt-5.5');
  });

  it('omits model on empty string (treated as unknown)', () => {
    // Defensive: an empty string is not a model id; we treat it the same
    // as undefined so callers can pass through values from SDK echoes
    // without normalizing first.
    const metadata = buildAssistantMessageMetadata({ model: '' });
    expect(metadata).not.toHaveProperty('model');
  });

  it('records token usage when provided', () => {
    const metadata = buildAssistantMessageMetadata({
      model: 'gpt-5.5',
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(metadata.tokens).toEqual({ input: 100, output: 50 });
  });

  it('defaults missing token counts to zero', () => {
    const metadata = buildAssistantMessageMetadata({ model: 'gpt-5.5' });
    expect(metadata.tokens).toEqual({ input: 0, output: 0 });
  });
});

describe('patchTaskModelIfKnown', () => {
  function createMockTasksService() {
    return {
      get: vi.fn(),
      patch: vi.fn().mockResolvedValue({}),
      emit: vi.fn(),
    };
  }

  it('patches Task.model when all inputs are present', async () => {
    const service = createMockTasksService();
    await patchTaskModelIfKnown(service, 'task-1', 'gpt-5.5');
    expect(service.patch).toHaveBeenCalledWith('task-1', { model: 'gpt-5.5' });
  });

  it('no-ops when model is undefined (legacy session)', async () => {
    const service = createMockTasksService();
    await patchTaskModelIfKnown(service, 'task-1', undefined);
    expect(service.patch).not.toHaveBeenCalled();
  });

  it('no-ops when model is the empty string', async () => {
    const service = createMockTasksService();
    await patchTaskModelIfKnown(service, 'task-1', '');
    expect(service.patch).not.toHaveBeenCalled();
  });

  it('no-ops when taskId is missing', async () => {
    const service = createMockTasksService();
    await patchTaskModelIfKnown(service, undefined, 'gpt-5.5');
    expect(service.patch).not.toHaveBeenCalled();
  });

  it('no-ops when tasksService is missing', async () => {
    // Should not throw on tools that don't wire in a TasksService.
    await expect(patchTaskModelIfKnown(undefined, 'task-1', 'gpt-5.5')).resolves.toBeUndefined();
  });
});
