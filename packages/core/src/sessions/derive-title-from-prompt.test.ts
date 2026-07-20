import { describe, expect, it } from 'vitest';
import { deriveTitleFromPrompt } from './derive-title-from-prompt.js';

describe('deriveTitleFromPrompt', () => {
  it('returns short prompts unchanged', () => {
    expect(deriveTitleFromPrompt('Add authentication to the login flow')).toBe(
      'Add authentication to the login flow'
    );
  });

  it('collapses internal whitespace and newlines', () => {
    expect(deriveTitleFromPrompt('Fix   the\n\nbug   in checkout')).toBe('Fix the bug in checkout');
  });

  it('trims leading/trailing whitespace', () => {
    expect(deriveTitleFromPrompt('   hello world   ')).toBe('hello world');
  });

  it('truncates long prompts at a word boundary with an ellipsis', () => {
    const prompt =
      'Implement a full JWT-based authentication system with secure password storage and refresh token rotation';
    const title = deriveTitleFromPrompt(prompt);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('hard-cuts when there is no reasonable word boundary', () => {
    const prompt = `${'a'.repeat(100)} b`;
    const title = deriveTitleFromPrompt(prompt);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns an empty string for blank input', () => {
    expect(deriveTitleFromPrompt('   ')).toBe('');
    expect(deriveTitleFromPrompt('')).toBe('');
  });
});
