import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURSOR_MODEL,
  ensureDefaultModelOption,
  getModelSelectorFallbackModel,
} from './modelDefaults';

describe('getModelSelectorFallbackModel', () => {
  it('uses the daemon Claude default instead of the first listed Claude alias', () => {
    expect(AVAILABLE_CLAUDE_MODEL_ALIASES[0]?.id).not.toBe(DEFAULT_CLAUDE_MODEL);

    expect(getModelSelectorFallbackModel('claude-code', AVAILABLE_CLAUDE_MODEL_ALIASES)).toBe(
      DEFAULT_CLAUDE_MODEL
    );
    expect(getModelSelectorFallbackModel('claude-code-cli', AVAILABLE_CLAUDE_MODEL_ALIASES)).toBe(
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
