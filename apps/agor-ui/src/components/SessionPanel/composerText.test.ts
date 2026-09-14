import { describe, expect, it } from 'vitest';
import { appendComposerText } from './composerText';

describe('appendComposerText', () => {
  it('preserves every existing character and appends a suggestion', () => {
    expect(appendComposerText('user draft', 'starter prompt')).toBe('user draft starter prompt');
    expect(appendComposerText('user draft\n', 'starter prompt')).toBe('user draft\nstarter prompt');
    expect(appendComposerText('  intentional spacing  ', 'starter prompt')).toBe(
      '  intentional spacing  starter prompt'
    );
  });

  it('inserts directly when the composer is empty', () => {
    expect(appendComposerText('', 'starter prompt')).toBe('starter prompt');
  });
});
