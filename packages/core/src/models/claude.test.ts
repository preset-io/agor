import { describe, expect, it } from 'vitest';
import { AVAILABLE_CLAUDE_MODEL_ALIASES } from './claude.js';

describe('AVAILABLE_CLAUDE_MODEL_ALIASES', () => {
  it('includes current Claude model aliases', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);

    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-fable-5');
  });
});
