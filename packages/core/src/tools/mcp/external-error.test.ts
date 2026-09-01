import { describe, expect, it, vi } from 'vitest';
import {
  asMCPExternalError,
  isMCPAbortError,
  MCPExternalError,
  sanitizeMCPExternalError,
} from './external-error';

describe('MCP external error boundary', () => {
  it.each([
    new TypeError('DNS failed for https://SENTINEL-DNS.example/private'),
    Object.assign(new Error('TLS certificate reflected SENTINEL-TLS'), { code: 'ENOTFOUND' }),
    { message: 'provider said SENTINEL-PROVIDER', code: 'ATTACKER_SECRET_CODE' },
    'SENTINEL-STRING-THROW',
  ])('returns and throws only the closed contract for %#', (failure) => {
    const safe = sanitizeMCPExternalError(failure, { stage: 'discovery' });
    const thrown = asMCPExternalError(failure, { stage: 'discovery' });
    const serialized = JSON.stringify({ safe, thrown: String(thrown), stack: thrown.stack });

    expect(serialized).not.toContain('SENTINEL');
    expect(safe.diagnostic.event).toBe('mcp_external_failure');
    expect(safe.diagnostic.stage).toBe('discovery');
    expect(['Error', 'TypeError', 'UnknownError']).toContain(safe.diagnostic.type);
    expect(thrown.message).toBe(safe.message);
  });

  it('allowlists stable network codes without retaining arbitrary codes', () => {
    const allowed = sanitizeMCPExternalError(
      Object.assign(new Error('SENTINEL'), { code: 'ECONNREFUSED' }),
      { stage: 'jwt' }
    );
    const rejected = sanitizeMCPExternalError(
      Object.assign(new Error('SENTINEL'), { code: 'SENTINEL_CODE' }),
      { stage: 'jwt' }
    );

    expect(allowed.diagnostic.code).toBe('ECONNREFUSED');
    expect(rejected.diagnostic.code).toBeUndefined();
    expect(JSON.stringify({ allowed, rejected })).not.toContain('SENTINEL');
  });

  it.each([
    [401, 'provider_rejected', 'reauthenticate'],
    [403, 'provider_rejected', 'reauthenticate'],
    [429, 'provider_unavailable', 'retry'],
    [503, 'provider_unavailable', 'retry'],
    [404, 'configuration_required', 'review_configuration'],
  ] as const)(
    'classifies an MCP SDK HTTP status %i without retaining its response body',
    (status, category, action) => {
      // StreamableHTTPError uses an own numeric `code`; its message contains
      // the untrusted response body and must remain outside the safe result.
      const failure = Object.assign(new Error('SENTINEL_PROVIDER_RESPONSE_BODY'), {
        code: status,
      });
      const safe = sanitizeMCPExternalError(failure, { stage: 'discovery' });

      expect(safe).toMatchObject({
        category,
        action,
        diagnostic: { type: 'HTTPError', status },
      });
      expect(safe.diagnostic.code).toBeUndefined();
      expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    }
  );

  it('does not reinterpret JSON-RPC codes as HTTP statuses', () => {
    const safe = sanitizeMCPExternalError(
      Object.assign(new Error('SENTINEL_JSON_RPC'), { code: -32603 }),
      { stage: 'discovery' }
    );

    expect(safe).toMatchObject({ category: 'unknown', diagnostic: { type: 'Error' } });
    expect(safe.diagnostic.status).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  it('fails closed when hostile code and name getters throw', () => {
    const failure = new Error('SENTINEL_HOSTILE_ERROR');
    const codeGetter = vi.fn(() => {
      throw new Error('SENTINEL_CODE_GETTER');
    });
    const nameGetter = vi.fn(() => {
      throw new Error('SENTINEL_NAME_GETTER');
    });
    Object.defineProperties(failure, {
      code: { get: codeGetter },
      name: { get: nameGetter },
    });

    const safe = sanitizeMCPExternalError(failure, { stage: 'runtime' });
    expect(safe).toMatchObject({
      category: 'unknown',
      action: 'retry',
      diagnostic: { type: 'Error' },
    });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    expect(codeGetter).not.toHaveBeenCalled();
    expect(nameGetter).not.toHaveBeenCalled();
  });

  it('recognizes genuine platform and SDK abort errors without trusting hostile getters', () => {
    const domAbort = new DOMException('SENTINEL_DOM_ABORT', 'AbortError');
    const sdkAbort = Object.assign(new Error('SENTINEL_SDK_ABORT'), { name: 'AbortError' });
    const codeAbort = Object.assign(new Error('SENTINEL_CODE_ABORT'), { code: 'ABORT_ERR' });
    const hostileGetter = vi.fn(() => {
      throw new Error('SENTINEL_HOSTILE_ABORT_GETTER');
    });
    const hostile = new Proxy(new Error('SENTINEL_HOSTILE_ABORT'), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'name' || property === 'code') {
          return { configurable: true, get: hostileGetter };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(isMCPAbortError(domAbort)).toBe(true);
    expect(isMCPAbortError(sdkAbort)).toBe(true);
    expect(isMCPAbortError(codeAbort)).toBe(true);
    expect(isMCPAbortError(hostile)).toBe(false);
    expect(hostileGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['provider_rejected', 'reauthenticate'],
    ['invalid_response', 'retry'],
    ['storage_policy_rejected', 'contact_admin'],
    ['configuration_required', 'review_configuration'],
  ] as const)('preserves the closed %s category/action pair', (category, action) => {
    const typed = asMCPExternalError(undefined, { stage: 'jwt', category });
    expect(sanitizeMCPExternalError(typed, { stage: 'oauth' })).toMatchObject({
      category,
      action,
      diagnostic: { stage: 'oauth' },
    });
  });

  it('keeps the persistence-validation diagnostic and user contract closed', () => {
    const safe = sanitizeMCPExternalError(new Error('SENTINEL_PROVIDER_FIELD'), {
      stage: 'discovery',
      category: 'storage_policy_rejected',
      reason: 'capability_persistence_validation_rejected',
    });

    expect(safe).toEqual({
      category: 'storage_policy_rejected',
      action: 'contact_admin',
      message:
        "The MCP server's capabilities did not meet Agor's storage safety limits, so Agor did not save them. Ask an administrator to review the secure operational event.",
      diagnostic: {
        event: 'mcp_external_failure',
        stage: 'discovery',
        type: 'Error',
        reason: 'capability_persistence_validation_rejected',
      },
    });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');

    const rejectedReason = sanitizeMCPExternalError(undefined, {
      stage: 'discovery',
      reason: 'SENTINEL_PROVIDER_REASON' as never,
    });
    expect(rejectedReason.diagnostic.reason).toBeUndefined();
    expect(JSON.stringify(rejectedReason)).not.toContain('SENTINEL');
  });

  it('accepts only a closed OAuth configuration diagnostic override', () => {
    const safe = sanitizeMCPExternalError(new Error('SENTINEL_OAUTH_METADATA'), {
      stage: 'oauth',
      category: 'configuration_required',
      type: 'ConfigurationError',
      reason: 'oauth_metadata_incompatible',
    });

    expect(safe).toMatchObject({
      category: 'configuration_required',
      diagnostic: {
        stage: 'oauth',
        type: 'ConfigurationError',
        reason: 'oauth_metadata_incompatible',
      },
    });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  it('re-closes forged typed errors instead of trusting their public prose or metadata', () => {
    const forged = new MCPExternalError({
      category: 'provider_unavailable',
      action: 'retry',
      message: 'SENTINEL_FORGED_MESSAGE',
      diagnostic: {
        event: 'mcp_external_failure',
        stage: 'jwt',
        type: 'Error',
        code: 'SENTINEL_FORGED_CODE',
      },
    });
    const safe = sanitizeMCPExternalError(forged, { stage: 'oauth_callback' });

    expect(JSON.stringify({ forged: String(forged), safe })).not.toContain('SENTINEL');
    expect(safe).toMatchObject({
      category: 'provider_unavailable',
      action: 'retry',
      diagnostic: { stage: 'oauth_callback', type: 'Error' },
    });
    expect(safe.diagnostic.code).toBeUndefined();
  });

  it('does not trust a Proxy wrapped around a nominal external error', () => {
    const sentinel = 'SENTINEL_EXTERNAL_PROXY';
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const getPrototypeOf = vi.fn(() => {
      throw new Error(sentinel);
    });
    const typed = asMCPExternalError(new Error(sentinel), {
      stage: 'oauth',
      category: 'provider_rejected',
    });
    const hostile = new Proxy(typed, {
      getPrototypeOf,
      getOwnPropertyDescriptor(target, property) {
        if (property === 'name' || property === 'code' || property === 'category') {
          return { configurable: true, get: getter };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const safe = sanitizeMCPExternalError(hostile, { stage: 'oauth' });
    expect(safe).toMatchObject({ category: 'unknown', action: 'retry' });
    expect(JSON.stringify(safe)).not.toContain(sentinel);
    expect(getter).not.toHaveBeenCalled();
    expect(getPrototypeOf).toHaveBeenCalled();
  });
});
