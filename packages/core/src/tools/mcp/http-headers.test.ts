import { describe, expect, it } from 'vitest';
import { mergeMCPRemoteHeaders, normalizeMCPCustomHeaders } from './http-headers';

describe('MCP HTTP header helpers', () => {
  it('filters invalid and reserved custom header names', () => {
    expect(
      normalizeMCPCustomHeaders({
        'DD-API-KEY': 'dummy-api-key',
        Authorization: 'Bearer custom-should-not-win',
        'bad header': 'nope',
        '': 'empty',
      })
    ).toEqual({ 'DD-API-KEY': 'dummy-api-key' });
  });

  it('merges base, custom, and auth headers with auth taking precedence', () => {
    expect(
      mergeMCPRemoteHeaders({
        base: { Accept: 'application/json' },
        custom: { 'DD-API-KEY': 'dummy-api-key', Authorization: 'Bearer custom' },
        auth: { Authorization: 'Bearer auth' },
      })
    ).toEqual({
      Accept: 'application/json',
      'DD-API-KEY': 'dummy-api-key',
      Authorization: 'Bearer auth',
    });
  });
});
