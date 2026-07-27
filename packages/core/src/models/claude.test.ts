import { describe, expect, it } from 'vitest';
import { AVAILABLE_CLAUDE_MODEL_ALIASES, hasNativeMillionContext } from './claude.js';

describe('AVAILABLE_CLAUDE_MODEL_ALIASES', () => {
  it('includes current Claude model aliases', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);

    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-fable-5');
  });

  it('does not offer synthetic [1m] variants for native-1M models', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);

    expect(ids).not.toContain('claude-opus-4-7[1m]');
    expect(ids).not.toContain('claude-opus-4-6[1m]');
    expect(ids).not.toContain('claude-sonnet-4-6[1m]');
    expect(ids).toContain('claude-sonnet-4-5[1m]');
  });
});

describe('hasNativeMillionContext', () => {
  it.each([
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8-20260528',
    'claude-opus-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('recognizes %s as native 1M', (modelId) => {
    expect(hasNativeMillionContext(modelId)).toBe(true);
  });

  it.each([
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-opus-4-20250514',
    'claude-sonnet-4-5',
  ])('keeps %s on the opt-in context path', (modelId) => {
    expect(hasNativeMillionContext(modelId)).toBe(false);
  });
});
