import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_TOKENS, serverSearchText } from './searchable-fields';

describe('serverSearchText', () => {
  it('keeps the first MAX_SEARCH_TOKENS distinct terms the daemon accepts', () => {
    expect(MAX_SEARCH_TOKENS).toBe(8);
    expect(serverSearchText('  Fix the the LOGIN flow a b c d e f g  ')).toBe(
      'fix the login flow a b c d'
    );
    expect(serverSearchText('one\ttwo\nthree')).toBe('one two three');
    expect(serverSearchText('   ')).toBe('');
  });
});
