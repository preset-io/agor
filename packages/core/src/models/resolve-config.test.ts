import { describe, expect, it } from 'vitest';
import { resolveModelConfig, resolveModelConfigPrecedence } from './resolve-config.js';

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
