import { describe, expect, it } from 'vitest';
import { buildCodexClientOptions, createCodexAuthStrategy } from './auth-strategy.js';

describe('createCodexAuthStrategy', () => {
  it('uses api_key when an API key is present', () => {
    expect(createCodexAuthStrategy('sk-test', false)).toEqual({
      kind: 'api_key',
      apiKey: 'sk-test',
    });
  });

  it('uses native when no key is available', () => {
    expect(createCodexAuthStrategy('', true)).toEqual({ kind: 'native' });
  });
});

describe('buildCodexClientOptions', () => {
  it('returns empty options for native auth', () => {
    expect(buildCodexClientOptions({ kind: 'native' })).toEqual({});
  });
});
