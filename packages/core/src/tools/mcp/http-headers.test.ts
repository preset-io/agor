import { describe, expect, it } from 'vitest';
import {
  isReservedMCPCustomHeaderName,
  isValidMCPHeaderName,
  MCP_HEADER_REDACTED_SENTINEL,
  mergeMCPRemoteHeaders,
  normalizeMCPCustomHeaders,
  redactMCPCustomHeaders,
  restoreRedactedMCPCustomHeaders,
} from './http-headers';

describe('MCP HTTP header helpers', () => {
  it('validates custom header names', () => {
    expect(isValidMCPHeaderName('DD-API-KEY')).toBe(true);
    expect(isValidMCPHeaderName('bad header')).toBe(false);
    expect(isReservedMCPCustomHeaderName('Authorization')).toBe(true);
    expect(isReservedMCPCustomHeaderName('X-Custom')).toBe(false);
  });

  it('filters invalid and reserved custom header names', () => {
    expect(
      normalizeMCPCustomHeaders({
        'DD-API-KEY': 'dummy-api-key',
        Authorization: 'Bearer custom-should-not-win',
        Cookie: 'session=secret',
        'Mcp-Session-Id': 'session-id',
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

  it('redacts custom header values while preserving names', () => {
    expect(
      redactMCPCustomHeaders({
        'DD-API-KEY': 'dummy-api-key',
        'X-Datadog-Parent-Org-Id': '1234',
      })
    ).toEqual({
      'DD-API-KEY': MCP_HEADER_REDACTED_SENTINEL,
      'X-Datadog-Parent-Org-Id': MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('preserves bare {{ user.env.NAME }} header templates but redacts everything else', () => {
    expect(
      redactMCPCustomHeaders({
        'X-API-Key': '{{ user.env.DATADOG_API_KEY }}',
        'X-Raw-Secret': 'dummy-api-key',
        'X-Partial': 'prefix-{{user.env.X}}',
        'X-Helper': '{{default user.env.MISSING "sk-live-shouldnotleak"}}',
      })
    ).toEqual({
      'X-API-Key': '{{ user.env.DATADOG_API_KEY }}',
      'X-Raw-Secret': MCP_HEADER_REDACTED_SENTINEL,
      'X-Partial': MCP_HEADER_REDACTED_SENTINEL,
      'X-Helper': MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('restores redacted values from existing headers and normalizes the result', () => {
    expect(
      restoreRedactedMCPCustomHeaders({
        current: {
          'DD-API-KEY': 'secret-value',
          'X-Datadog-Parent-Org-Id': '1234',
        },
        next: {
          'DD-API-KEY': MCP_HEADER_REDACTED_SENTINEL,
          'X-Datadog-Parent-Org-Id': '5678',
          Authorization: 'Bearer should-not-persist',
        },
      })
    ).toEqual({
      'DD-API-KEY': 'secret-value',
      'X-Datadog-Parent-Org-Id': '5678',
    });
  });
});
