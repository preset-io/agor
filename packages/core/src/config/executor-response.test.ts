import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
  EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
  EXECUTOR_RESPONSE_DEFAULT_TIMEOUT_MS,
  resolveExecutorResponseConfig,
  resolveExecutorResponseTimeoutMs,
} from './executor-response.js';

describe('executor response config', () => {
  it('applies bounded defaults', () => {
    expect(resolveExecutorResponseConfig()).toEqual({
      maxResponseBytes: EXECUTOR_RESPONSE_DEFAULT_MAX_BYTES,
      maxActiveRequests: EXECUTOR_RESPONSE_DEFAULT_MAX_ACTIVE,
      defaultTimeoutMs: EXECUTOR_RESPONSE_DEFAULT_TIMEOUT_MS,
      timeoutByCommand: {},
    });
  });

  it('normalizes a configured origin and protocol declaration', () => {
    expect(
      resolveExecutorResponseConfig({
        max_response_bytes: 1024,
        max_active_requests: 2,
        timeout_ms: {
          default: 90_000,
          by_command: { 'branch.files.read': 15_000 },
        },
        origin_url: 'https://daemon-0.internal:3030/',
        external_protocol: 'executor-response-v1',
      })
    ).toEqual({
      maxResponseBytes: 1024,
      maxActiveRequests: 2,
      defaultTimeoutMs: 90_000,
      timeoutByCommand: { 'branch.files.read': 15_000 },
      originUrl: 'https://daemon-0.internal:3030',
      externalProtocol: 'executor-response-v1',
    });
  });

  it.each([
    [{ max_response_bytes: 0 }, /max_response_bytes/],
    [{ max_response_bytes: 64 * 1024 * 1024 + 1 }, /max_response_bytes/],
    [{ max_active_requests: 0 }, /max_active_requests/],
    [{ timeout_ms: { default: 999 } }, /timeout_ms\.default/],
    [{ timeout_ms: [] as never }, /timeout_ms must be an object/],
    [{ timeout_ms: { by_command: [] as never } }, /command-to-milliseconds mapping/],
    [
      { timeout_ms: { by_command: { 'branch.files.read': 24 * 60 * 60_000 + 1 } } },
      /branch\.files\.read/,
    ],
    [{ timeout_ms: { by_command: { 'bad command': 5_000 } } }, /executor command names/],
    [{ origin_url: 'redis://internal' }, /http/i],
    [{ origin_url: 'https://user:secret@internal' }, /credentials/i],
    [{ origin_url: 'https://internal/path' }, /without a path/i],
    [{ external_protocol: 'executor-response-v1' }, /requires.*origin_url/i],
  ] as const)('rejects unsafe config %#', (input, pattern) => {
    expect(() => resolveExecutorResponseConfig(input)).toThrow(pattern);
  });

  it('uses command override, call-specific default, then global default', () => {
    const config = resolveExecutorResponseConfig({
      timeout_ms: {
        default: 300_000,
        by_command: { 'branch.files.read': 30_000 },
      },
    });

    expect(resolveExecutorResponseTimeoutMs(config, 'branch.files.read', 600_000)).toBe(30_000);
    expect(resolveExecutorResponseTimeoutMs(config, 'environment.start', 600_000)).toBe(600_000);
    expect(resolveExecutorResponseTimeoutMs(config, 'branch.files.list')).toBe(300_000);
  });
});
