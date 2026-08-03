import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_MODEL,
  hasNativeMillionContext,
} from './claude.js';

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

    expect(ids).not.toContain('claude-opus-5[1m]');
    expect(ids).not.toContain('claude-opus-4-7[1m]');
    expect(ids).not.toContain('claude-opus-4-6[1m]');
    expect(ids).not.toContain('claude-sonnet-4-6[1m]');
    expect(ids).toContain('claude-sonnet-4-5[1m]');
  });

  it('lists Opus 5 ahead of every older Opus', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);
    const opus5 = ids.indexOf('claude-opus-5');
    const olderOpus = ids.filter((id) => id.startsWith('claude-opus-4'));

    expect(opus5).toBeGreaterThanOrEqual(0);
    expect(olderOpus.length).toBeGreaterThan(0);
    // curateModelOptions() preserves this order (only hoisting the default),
    // so registry position is what the picker renders.
    for (const id of olderOpus) {
      expect(ids.indexOf(id)).toBeGreaterThan(opus5);
    }
  });

  it('keeps Sonnet 5 as the default model', () => {
    // Opus 5 is the newest Opus, not the new default. Changing this is a
    // deliberate product decision, not a side effect of adding a model.
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-sonnet-5');
    expect(AVAILABLE_CLAUDE_MODEL_ALIASES.map((m) => m.id)).toContain(DEFAULT_CLAUDE_MODEL);
  });
});

describe('hasNativeMillionContext', () => {
  it.each([
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8-20260528',
    'claude-opus-5',
    'claude-opus-5-20260101',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('recognizes %s as native 1M', (modelId) => {
    expect(hasNativeMillionContext(modelId)).toBe(true);
  });

  it.each(['claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-sonnet-4-5'])(
    'keeps %s on the opt-in context path',
    (modelId) => {
      expect(hasNativeMillionContext(modelId)).toBe(false);
    }
  );
});
