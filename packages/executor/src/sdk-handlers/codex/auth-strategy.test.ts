import { describe, expect, it } from 'vitest';
import {
  buildCodexClientOptions,
  createCodexAuthStrategy,
  getCodexAuthFailureGuidance,
  getCodexAuthStrategyCacheKey,
} from './auth-strategy.js';

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

describe('getCodexAuthStrategyCacheKey', () => {
  it('returns a stable key for native auth', () => {
    expect(getCodexAuthStrategyCacheKey({ kind: 'native' })).toBe('native');
  });
});

describe('getCodexAuthFailureGuidance', () => {
  it('returns codex login guidance for native auth failures', () => {
    expect(getCodexAuthFailureGuidance({ kind: 'native' }, '401 Unauthorized')).toContain(
      'codex login'
    );
  });
});
