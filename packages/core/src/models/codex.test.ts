import { describe, expect, it } from 'vitest';
import {
  CODEX_MINI_MODEL,
  CODEX_MODEL_METADATA,
  CODEX_MODEL_REGISTRY,
  DEFAULT_CODEX_MODEL,
  formatUnsupportedAgorCodexModelMessage,
  getCodexModelLifecycle,
  isUnsupportedAgorCodexModel,
} from './codex.js';

describe('Codex model registry', () => {
  it('keeps current defaults on supported Codex models', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(CODEX_MINI_MODEL).toBe('gpt-5.6-terra');
  });

  it('surfaces only selectable models to callers', () => {
    const selectableIds = Object.keys(CODEX_MODEL_METADATA);

    expect(selectableIds).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(selectableIds).not.toContain('gpt-5.5');
    expect(selectableIds).not.toContain('gpt-5.4-mini');
    expect(selectableIds).not.toContain('gpt-5.4');
    expect(selectableIds).not.toContain('gpt-5-codex');
  });

  it('keeps legacy aliases in the lifecycle registry for diagnostics', () => {
    expect(CODEX_MODEL_REGISTRY['gpt-5-codex']).toMatchObject({
      selectable: false,
      availability: 'unsupported',
      replacement: 'gpt-5.6-sol',
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
    expect(message).toContain('gpt-5.6-sol');
    expect(message).toContain('user defaults');
    expect(message).toContain('omit modelConfig');
  });
});
