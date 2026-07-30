import { describe, expect, it } from 'vitest';
import { validateOpenCodeOAuthAuthorizationUrl } from './auth-handler';

describe('OpenCode OAuth authorization URLs', () => {
  it.each([
    ['https://provider.example/oauth?state=opaque', 'https://provider.example/oauth?state=opaque'],
    ['http://127.0.0.1:4321/callback', 'http://127.0.0.1:4321/callback'],
    ['http://localhost:4321/callback', 'http://localhost:4321/callback'],
    ['http://[::1]:4321/callback', 'http://[::1]:4321/callback'],
  ])('allows %s', (input, expected) => {
    expect(validateOpenCodeOAuthAuthorizationUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'http://provider.example/oauth',
    'https://user:secret@provider.example/oauth',
    'not a url',
  ])('rejects %s', (input) => {
    expect(() => validateOpenCodeOAuthAuthorizationUrl(input)).toThrow(/OAuth authorization URL/i);
  });
});
