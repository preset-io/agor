import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
  EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
  resolveExecutorResponseConfig,
} from './executor-response.js';

describe('executor response config', () => {
  it('applies bounded defaults', () => {
    expect(resolveExecutorResponseConfig()).toEqual({
      maxResponseBytes: EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
      maxActiveRequests: EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
    });
  });

  it('normalizes a configured origin and protocol declaration', () => {
    expect(
      resolveExecutorResponseConfig({
        max_response_bytes: 1024,
        max_active_requests: 2,
        origin_url: 'https://daemon-0.internal:3030/',
        external_protocol: 'executor-response-v1',
      })
    ).toEqual({
      maxResponseBytes: 1024,
      maxActiveRequests: 2,
      originUrl: 'https://daemon-0.internal:3030',
      externalProtocol: 'executor-response-v1',
    });
  });

  it.each([
    [{ max_response_bytes: 0 }, /max_response_bytes/],
    [{ max_response_bytes: 64 * 1024 * 1024 + 1 }, /max_response_bytes/],
    [{ max_active_requests: 0 }, /max_active_requests/],
    [{ origin_url: 'redis://internal' }, /http/i],
    [{ origin_url: 'https://user:secret@internal' }, /credentials/i],
    [{ origin_url: 'https://internal/path' }, /without a path/i],
    [{ external_protocol: 'executor-response-v1' }, /requires.*origin_url/i],
  ] as const)('rejects unsafe config %#', (input, pattern) => {
    expect(() => resolveExecutorResponseConfig(input)).toThrow(pattern);
  });
});
