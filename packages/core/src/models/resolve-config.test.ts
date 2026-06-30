import { describe, expect, it } from 'vitest';
import {
  getDefaultModelForTool,
  resolveModelConfig,
  resolveModelConfigPrecedence,
  resolveModelConfigWithFallback,
} from './resolve-config.js';

describe('resolveModelConfig', () => {
  const now = new Date('2026-04-23T00:00:00.000Z');

  it('returns undefined when input is undefined', () => {
    expect(resolveModelConfig(undefined)).toBeUndefined();
  });

  it('returns undefined when input has no model', () => {
    expect(resolveModelConfig({ mode: 'alias', effort: 'high' }, { now })).toBeUndefined();
    expect(resolveModelConfig({ model: '' }, { now })).toBeUndefined();
  });

  it('normalizes a minimal input (defaults mode to alias, stamps updated_at)', () => {
    expect(resolveModelConfig({ model: 'claude-opus-4-6' }, { now })).toEqual({
      mode: 'alias',
      model: 'claude-opus-4-6',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('preserves explicit mode', () => {
    expect(
      resolveModelConfig({ mode: 'exact', model: 'claude-sonnet-4-5-20250929' }, { now })
    ).toMatchObject({ mode: 'exact' });
  });

  it('includes effort only when defined (omits the key otherwise)', () => {
    const withEffort = resolveModelConfig({ model: 'x', effort: 'max' }, { now });
    expect(withEffort).toHaveProperty('effort', 'max');

    const withoutEffort = resolveModelConfig({ model: 'x' }, { now });
    expect(withoutEffort).not.toHaveProperty('effort');
  });

  it('round-trips xhigh effort through resolveModelConfig', () => {
    const result = resolveModelConfig({ model: 'x', effort: 'xhigh' }, { now });
    expect(result).toHaveProperty('effort', 'xhigh');
  });

  it('includes advisorModel only when defined (omits the key otherwise)', () => {
    const withAdvisor = resolveModelConfig({ model: 'x', advisorModel: 'opus' }, { now });
    expect(withAdvisor).toHaveProperty('advisorModel', 'opus');

    const withoutAdvisor = resolveModelConfig({ model: 'x' }, { now });
    expect(withoutAdvisor).not.toHaveProperty('advisorModel');
  });

  it('includes provider only when defined (omits the key otherwise)', () => {
    const withProvider = resolveModelConfig(
      { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      { now }
    );
    expect(withProvider).toHaveProperty('provider', 'anthropic');

    const withoutProvider = resolveModelConfig({ model: 'claude-sonnet-4-6' }, { now });
    expect(withoutProvider).not.toHaveProperty('provider');
  });

  it('stamps updated_at from injected `now` (deterministic)', () => {
    const pinned = new Date('2000-01-01T12:00:00.000Z');
    expect(resolveModelConfig({ model: 'x' }, { now: pinned })?.updated_at).toBe(
      '2000-01-01T12:00:00.000Z'
    );
  });
});

describe('resolveModelConfigPrecedence', () => {
  const now = new Date('2026-04-23T00:00:00.000Z');

  it('returns the first resolvable source', () => {
    const explicit = { model: 'claude-opus-4-6', effort: 'max' as const };
    const userDefault = { model: 'claude-sonnet-4-6', effort: 'medium' as const };
    const result = resolveModelConfigPrecedence([explicit, userDefault], { now });
    expect(result?.model).toBe('claude-opus-4-6');
    expect(result?.effort).toBe('max');
  });

  it('falls through past sources with no model', () => {
    const noModel = { mode: 'alias' as const };
    const userDefault = { model: 'claude-sonnet-4-6' };
    const result = resolveModelConfigPrecedence([undefined, noModel, userDefault], { now });
    expect(result?.model).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when every source is empty', () => {
    expect(resolveModelConfigPrecedence([undefined, null, { mode: 'alias' }])).toBeUndefined();
  });

  it('does not mix fields across sources (first-wins, not merge)', () => {
    // Regression guard: the resolver picks ONE source and normalizes it.
    // It must NOT fall back to userDefault.effort when explicit has no effort.
    const explicit = { model: 'claude-opus-4-6' }; // no effort
    const userDefault = { model: 'claude-sonnet-4-6', effort: 'high' as const };
    const result = resolveModelConfigPrecedence([explicit, userDefault], { now });
    expect(result?.model).toBe('claude-opus-4-6');
    expect(result).not.toHaveProperty('effort');
  });
});

describe('getDefaultModelForTool', () => {
  it('returns the static default for tools that have one', () => {
    expect(getDefaultModelForTool('claude-code')).toBe('claude-sonnet-4-6');
    expect(getDefaultModelForTool('claude-code-cli')).toBe('claude-sonnet-4-6');
    expect(getDefaultModelForTool('codex')).toBe('gpt-5.5');
    expect(getDefaultModelForTool('gemini')).toBe('gemini-2.0-flash');
    expect(getDefaultModelForTool('copilot')).toBe('claude-sonnet-4.6');
  });

  it('returns undefined for cursor / opencode', () => {
    expect(getDefaultModelForTool('cursor')).toBeUndefined();
    expect(getDefaultModelForTool('opencode')).toBeUndefined();
  });
});

describe('resolveModelConfigWithFallback', () => {
  const now = new Date('2026-04-23T00:00:00.000Z');

  it('returns the first usable source when one is provided', () => {
    const result = resolveModelConfigWithFallback(
      'codex',
      [{ model: 'gpt-5.5' }, { model: 'gpt-4o' }],
      { now }
    );
    expect(result?.model).toBe('gpt-5.5');
  });

  it('falls back to the tool default when no source has a model', () => {
    const result = resolveModelConfigWithFallback('codex', [undefined, null], { now });
    expect(result).toEqual({
      mode: 'alias',
      model: 'gpt-5.5',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('merges effort-only high-priority input onto the next model source', () => {
    const result = resolveModelConfigWithFallback(
      'claude-code',
      [{ effort: 'max' }, { model: 'claude-opus-4-6', effort: 'high' }],
      { now }
    );
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-opus-4-6',
      effort: 'max',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('merges effort-only input onto the tool fallback when no source has a model', () => {
    const result = resolveModelConfigWithFallback('claude-code', [{ effort: 'max' }], { now });
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-sonnet-4-6',
      effort: 'max',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('merges advisor-only input onto the tool fallback when no source has a model', () => {
    const result = resolveModelConfigWithFallback('claude-code', [{ advisorModel: 'opus' }], {
      now,
    });
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-sonnet-4-6',
      advisorModel: 'opus',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('accumulates split model-less overrides onto the tool fallback', () => {
    const result = resolveModelConfigWithFallback(
      'claude-code',
      [{ advisorModel: 'opus' }, { effort: 'max' }],
      { now }
    );
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-sonnet-4-6',
      effort: 'max',
      advisorModel: 'opus',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('preserves higher-priority model-less overrides when accumulating', () => {
    const result = resolveModelConfigWithFallback(
      'claude-code',
      [
        { advisorModel: 'opus' },
        { advisorModel: 'sonnet', effort: 'medium' },
        { model: 'claude-haiku-4-5' },
      ],
      { now }
    );
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-haiku-4-5',
      effort: 'medium',
      advisorModel: 'opus',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
  });

  it('does not inherit a lower-priority advisorModel onto a higher-priority model source (turn-off contract)', () => {
    // Regression guard for "remove the advisor": once a higher-priority source
    // supplies its own model WITHOUT an advisor (e.g. an explicit session-level
    // model_config), a lower-priority source's advisorModel (e.g. the user
    // default) must NOT leak back in. The high-priority full config wins
    // first-wins, so advisor stays cleared.
    const result = resolveModelConfigWithFallback(
      'claude-code',
      [{ model: 'claude-opus-4-6' }, { model: 'claude-sonnet-4-6', advisorModel: 'opus' }],
      { now }
    );
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-opus-4-6',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('advisorModel');
  });

  it('does not carry model-less mode/provider onto a fallback model', () => {
    const result = resolveModelConfigWithFallback(
      'claude-code',
      [{ mode: 'exact', provider: 'anthropic', effort: 'max' }],
      { now }
    );
    expect(result).toEqual({
      mode: 'alias',
      model: 'claude-sonnet-4-6',
      effort: 'max',
      updated_at: '2026-04-23T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('provider');
  });

  it('returns undefined for cursor / opencode when sources are empty', () => {
    expect(resolveModelConfigWithFallback('cursor', [undefined], { now })).toBeUndefined();
    expect(resolveModelConfigWithFallback('opencode', [undefined], { now })).toBeUndefined();
  });

  it('still uses an explicit source for tools without a static default', () => {
    const result = resolveModelConfigWithFallback('cursor', [{ model: 'composer-experimental' }], {
      now,
    });
    expect(result?.model).toBe('composer-experimental');
  });
});
