import { describe, expect, it } from 'vitest';
import { AVAILABLE_CLAUDE_MODEL_ALIASES } from './claude.js';

describe('AVAILABLE_CLAUDE_MODEL_ALIASES', () => {
  it('includes generally available Claude Fable 5 variants', () => {
    const ids = AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => model.id);

    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('claude-fable-5[1m]');
    expect(ids).not.toContain('claude-mythos-5');
  });
});
