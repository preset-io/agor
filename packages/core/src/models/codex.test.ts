import { describe, expect, it } from 'vitest';
import {
  CODEX_MINI_MODEL,
  CODEX_MODEL_METADATA,
  CODEX_MODEL_REGISTRY,
  DEFAULT_CODEX_MODEL,
  formatUnsupportedAgorCodexModelMessage,
  getCodexModelLifecycle,
  getCodexModelSelectionError,
  isUnsupportedAgorCodexModel,
} from './codex.js';

describe('Codex model registry', () => {
  it('keeps current defaults on supported Codex models', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6-astra');
    expect(CODEX_MINI_MODEL).toBe('gpt-5.6-terra');
  });

  it('surfaces supported and provider-dependent models newest-first', () => {
    const selectableIds = Object.keys(CODEX_MODEL_METADATA);

    expect(selectableIds.slice(0, 4)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(CODEX_MODEL_METADATA['gpt-6-astra'].availability).toBe('provider-dependent');
    expect(CODEX_MODEL_REGISTRY['gpt-5.6'].replacement).toBe('gpt-5.6-sol');
    expect(selectableIds).toContain('gpt-5.5');
    expect(selectableIds).toContain('gpt-5.4-mini');
    expect(selectableIds).toContain('gpt-5.4');
    expect(selectableIds).not.toContain('gpt-5-codex');
    expect(CODEX_MODEL_METADATA['gpt-5.5'].availability).toBe('provider-dependent');
  });

  it('keeps legacy aliases in the lifecycle registry for diagnostics', () => {
    expect(CODEX_MODEL_REGISTRY['gpt-5-codex']).toMatchObject({
      selectable: false,
      availability: 'unsupported',
      replacement: 'gpt-6-astra',
    });
  });

  it('matches exact and dated legacy aliases', () => {
    expect(getCodexModelLifecycle('gpt-5-codex')).toBe(CODEX_MODEL_REGISTRY['gpt-5-codex']);
    expect(getCodexModelLifecycle('gpt-5-codex-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5-codex']
    );
    expect(getCodexModelLifecycle('gpt-5-codex-mini-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5-codex-mini']
    );
    expect(getCodexModelLifecycle('gpt-5.4-mini-2026-01-01')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5.4-mini']
    );
    expect(getCodexModelLifecycle('gpt-5.6-luna-2026-07-09')).toBe(
      CODEX_MODEL_REGISTRY['gpt-5.6-luna']
    );
  });

  it('flags only known unsupported Agor Codex aliases', () => {
    expect(isUnsupportedAgorCodexModel('gpt-5-codex')).toBe(true);
    expect(isUnsupportedAgorCodexModel('gpt-5-codex-mini')).toBe(true);
    expect(isUnsupportedAgorCodexModel('gpt-5.6-sol')).toBe(false);
    expect(isUnsupportedAgorCodexModel('internal-model-v1')).toBe(false);
  });

  it('formats a user-actionable unsupported-model message', () => {
    const message = formatUnsupportedAgorCodexModelMessage('gpt-5-codex');

    expect(message).toContain('gpt-5-codex');
    expect(message).toContain('gpt-6-astra');
    expect(message).toContain('user defaults');
    expect(message).toContain('omit modelConfig');
  });

  it('accepts curated aliases and rejects unknown alias selections actionably', () => {
    expect(getCodexModelSelectionError({ mode: 'alias', model: 'gpt-6-astra' })).toBeUndefined();
    expect(getCodexModelSelectionError({ mode: 'alias', model: 'gpt-5.6-sol' })).toBeUndefined();
    expect(getCodexModelSelectionError({ mode: 'alias', model: 'gpt-5.4' })).toBeUndefined();

    const error = getCodexModelSelectionError({
      mode: 'alias',
      model: 'gpt-5.6-codex',
    });
    expect(error).toContain('gpt-5.6-codex');
    expect(error).toContain('agor_models_list');
    expect(error).toContain('mode "exact"');
  });

  it('requires dated provider snapshots to use exact mode', () => {
    const snapshot = 'gpt-5.6-sol-2026-07-09';

    expect(getCodexModelSelectionError({ mode: 'alias', model: snapshot })).toContain(
      'mode "exact"'
    );
    expect(getCodexModelSelectionError({ mode: 'exact', model: snapshot })).toBeUndefined();
  });

  it('rejects non-canonical alias casing instead of persisting it unchanged', () => {
    const error = getCodexModelSelectionError({
      mode: 'alias',
      model: 'GPT-5.6-SOL',
    });

    expect(error).toContain('canonical registry casing');
    expect(error).toContain('"gpt-5.6-sol"');
    expect(getCodexModelSelectionError({ mode: 'exact', model: 'GPT-5.6-SOL' })).toBeUndefined();
  });

  it('allows unknown exact provider IDs but still rejects known unsupported aliases', () => {
    expect(
      getCodexModelSelectionError({ mode: 'exact', model: 'account-preview-model' })
    ).toBeUndefined();
    expect(getCodexModelSelectionError({ mode: 'exact', model: 'gpt-5-codex' })).toContain(
      'legacy alias'
    );
  });
});
