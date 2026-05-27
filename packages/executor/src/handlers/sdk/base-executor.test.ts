import { describe, expect, it } from 'vitest';
import { resolveTaskModelFromResult } from './base-executor.js';

describe('resolveTaskModelFromResult', () => {
  // Regression: user selected GPT 5.5 in session settings; before the fix
  // the Codex normalizer's hardcoded primaryModel ("gpt-5.4") was clobbering
  // the resolved model on every task patch. result.model is the source of
  // truth — it carries session.model_config.model end-to-end.
  it('prefers the tool-reported model over the normalizer-derived one', () => {
    expect(resolveTaskModelFromResult('gpt-5.5', 'gpt-5.4')).toBe('gpt-5.5');
  });

  // Codex/Gemini path: their normalizers intentionally leave primaryModel
  // undefined because the raw SDK event doesn't echo the model.
  it('returns the tool-reported model when normalizer omits one', () => {
    expect(resolveTaskModelFromResult('gpt-5.5', undefined)).toBe('gpt-5.5');
  });

  // Claude/Copilot path: SDK event carries the model; tool may also report
  // one. Either way, the agreed model is returned.
  it('falls back to normalizer-derived model when tool result omits one', () => {
    expect(resolveTaskModelFromResult(undefined, 'claude-sonnet-4-5-20250929')).toBe(
      'claude-sonnet-4-5-20250929'
    );
  });

  // Legacy path / pre-normalization tasks: neither source has a model.
  // Caller should leave Task.model untouched rather than writing "".
  it('returns undefined when neither source has a model', () => {
    expect(resolveTaskModelFromResult(undefined, undefined)).toBeUndefined();
  });

  // Empty strings count as missing (truthy guard); avoid clobbering with "".
  it('treats empty strings as missing values', () => {
    expect(resolveTaskModelFromResult('', '')).toBeUndefined();
    expect(resolveTaskModelFromResult('', 'gpt-5.4')).toBe('gpt-5.4');
  });
});
