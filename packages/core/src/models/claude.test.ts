import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  getClaudeContextWindowLimit,
  hasNativeMillionContext,
  supportsClaudeExtendedContext,
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
    expect(ids).toContain('claude-fable-5-1');
    expect(ids).toContain('claude-fable-5');
  });

  it('offers distinct standard and 1M choices only for Claude Code supported models', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);

    expect(ids).toContain('claude-opus-4-8[1m]');
    expect(ids).toContain('claude-opus-4-7[1m]');
    expect(ids).toContain('claude-opus-4-6[1m]');
    expect(ids).not.toContain('claude-sonnet-5[1m]');
    expect(ids).toContain('claude-sonnet-4-6[1m]');
    expect(ids).toContain('claude-opus-5[1m]');
    expect(ids).not.toContain('claude-sonnet-4-5[1m]');
  });
});

describe('hasNativeMillionContext', () => {
  it.each(['claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5'])(
    'recognizes %s as native 1M',
    (modelId) => {
      expect(hasNativeMillionContext(modelId)).toBe(true);
    }
  );

  it.each(['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'])(
    'keeps %s on the opt-in context path',
    (modelId) => {
      expect(hasNativeMillionContext(modelId)).toBe(false);
      expect(hasNativeMillionContext(`${modelId}[1m]`)).toBe(false);
    }
  );
});

describe('Claude context-window accounting fallback', () => {
  it.each(['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'])(
    'recognizes %s as a dual context choice',
    (modelId) => expect(supportsClaudeExtendedContext(modelId)).toBe(true)
  );

  it('distinguishes persisted standard, extended, and native-only selections', () => {
    expect(getClaudeContextWindowLimit('claude-opus-4-8')).toBe(200_000);
    expect(getClaudeContextWindowLimit('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(getClaudeContextWindowLimit('claude-opus-5')).toBe(200_000);
    expect(getClaudeContextWindowLimit('claude-opus-5[1m]')).toBe(1_000_000);
    expect(getClaudeContextWindowLimit('claude-sonnet-5')).toBe(1_000_000);
    expect(getClaudeContextWindowLimit('claude-fable-5-1')).toBe(1_000_000);
  });

  it('does not guess for unknown exact models or unsupported suffixes', () => {
    expect(getClaudeContextWindowLimit('custom-claude-model')).toBeUndefined();
    expect(getClaudeContextWindowLimit('claude-sonnet-4-5[1m]')).toBeUndefined();
    expect(getClaudeContextWindowLimit('claude-opus-5-private')).toBeUndefined();
    expect(getClaudeContextWindowLimit('claude-opus-4-8-preview[1m]')).toBeUndefined();
    expect(supportsClaudeExtendedContext('claude-opus-5-private')).toBe(false);
    expect(hasNativeMillionContext('claude-sonnet-5-private')).toBe(false);
  });
});
