import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  curateModelOptions,
  DEFAULT_CURSOR_MODEL,
  ensureDefaultModelOption,
  getModelDisplayName,
  getModelSelectorFallbackModel,
  normalizeModelOption,
} from './modelDefaults';

describe('getModelSelectorFallbackModel', () => {
  it('uses the daemon Claude default instead of the first listed Claude alias', () => {
    expect(AVAILABLE_CLAUDE_MODEL_ALIASES[0]?.id).not.toBe(DEFAULT_CLAUDE_MODEL);

    expect(getModelSelectorFallbackModel('claude-code', AVAILABLE_CLAUDE_MODEL_ALIASES)).toBe(
      DEFAULT_CLAUDE_MODEL
    );
  });

  it('uses canonical non-Claude defaults even when model lists are newest-first', () => {
    expect(getModelSelectorFallbackModel('gemini', [{ id: 'gemini-3-flash' }])).toBe(
      DEFAULT_GEMINI_MODEL
    );
  });

  it('adds a synthetic option when a dynamic default is absent from the returned list', () => {
    const options = ensureDefaultModelOption([{ id: 'account-model' }], 'default-model', (id) => ({
      id,
    }));
    expect(options.map((option) => option.id)).toEqual(['default-model', 'account-model']);
  });

  it('uses dynamic tool defaults for cursor and copilot', () => {
    expect(getModelSelectorFallbackModel('cursor', [])).toBe(DEFAULT_CURSOR_MODEL);
    expect(
      getModelSelectorFallbackModel('cursor', [], { cursorDefaultModel: 'cursor-account-default' })
    ).toBe('cursor-account-default');
    expect(
      getModelSelectorFallbackModel('copilot', [], { copilotDefaultModel: 'copilot-live-default' })
    ).toBe('copilot-live-default');
  });
});

describe('curateModelOptions (Claude)', () => {
  const normalized = AVAILABLE_CLAUDE_MODEL_ALIASES.map(normalizeModelOption);

  it('keeps preferred and previous aliases available', () => {
    const ids = curateModelOptions('claude-code', normalized, DEFAULT_CLAUDE_MODEL).map(
      (m) => m.id
    );

    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-opus-4-1');
    expect(ids).toContain('claude-opus-4-8[1m]');
    expect(ids).not.toContain('claude-sonnet-5[1m]');
    expect(ids).not.toContain('claude-sonnet-4-5[1m]');
    expect(ids).toHaveLength(normalized.length);
  });

  it('surfaces the default/recommended model first', () => {
    const ids = curateModelOptions('claude-code', normalized, DEFAULT_CLAUDE_MODEL).map(
      (m) => m.id
    );
    expect(ids[0]).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('surfaces a previous alias first when it is the configured default', () => {
    const ids = curateModelOptions('claude-code', normalized, 'claude-sonnet-4-5').map((m) => m.id);
    expect(ids[0]).toBe('claude-sonnet-4-5');
    expect(ids).toHaveLength(normalized.length);
  });

  it('passes non-Claude lists through unchanged aside from default-first ordering', () => {
    const codex = [
      { id: 'gpt-a', displayName: 'A' },
      { id: 'gpt-b', displayName: 'B' },
    ];
    const curated = curateModelOptions('codex', codex, 'gpt-b');
    expect(curated.map((m) => m.id)).toEqual(['gpt-b', 'gpt-a']);
  });
});

describe('normalizeModelOption', () => {
  it('preserves provider availability metadata for picker presentation', () => {
    expect(
      normalizeModelOption({
        id: 'older-model',
        label: 'Older model',
        availability: 'provider-dependent',
      })
    ).toMatchObject({
      id: 'older-model',
      displayName: 'Older model',
      availability: 'provider-dependent',
    });
  });
});

describe('getModelDisplayName', () => {
  it('resolves Claude ids to their friendly display name', () => {
    expect(getModelDisplayName('claude-code', 'claude-sonnet-5')).toBe('Claude Sonnet 5 · 1M');
  });

  it('annotates the 1M context variant', () => {
    expect(getModelDisplayName('claude-code', 'claude-sonnet-4-6[1m]')).toBe(
      'Claude Sonnet 4.6 · 1M'
    );
  });

  it('falls back to the raw id for unknown models', () => {
    expect(getModelDisplayName('claude-code', 'some-unknown-model')).toBe('some-unknown-model');
  });

  it('preserves unsupported legacy context suffixes instead of hiding the selection', () => {
    expect(getModelDisplayName('claude-code', 'claude-sonnet-4-5[1m]')).toBe(
      'claude-sonnet-4-5[1m]'
    );
  });
});
