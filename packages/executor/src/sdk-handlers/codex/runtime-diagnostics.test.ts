import type { SessionID, TaskID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntimeDiagnostics } from './runtime-diagnostics.js';

describe('Codex runtime diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  // Defensive extension metadata, NOT fixtures claiming the pinned Codex JSONL
  // emits HTTP statuses. Its declared errors are message-only (see service tests).
  it.each([
    [{ status: 401 }, 'category=provider_rejected type=HTTPError status=401'],
    [{ statusCode: 429 }, 'category=provider_unavailable type=HTTPError status=429'],
    [{ status: 400 }, 'category=configuration_required type=HTTPError status=400'],
    [{ status: 503 }, 'category=provider_unavailable type=HTTPError status=503'],
    [{ code: 'ETIMEDOUT' }, 'category=provider_unavailable type=NetworkError code=ETIMEDOUT'],
    [{ code: 'EACCES' }, 'category=runtime_failure type=SystemError code=EACCES'],
    [new TypeError('SENTINEL'), 'category=unknown type=TypeError'],
    [new Error('Codex Exec exited with code 1: SENTINEL'), 'category=unknown type=Error'],
  ])('retains only closed metadata in lifecycle logs: %j', (failure, expected) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID).recordFailure(
      'turn_failed',
      failure
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(JSON.stringify(error.mock.calls)).not.toContain('SENTINEL');
  });

  it.each([
    null,
    undefined,
    401,
    '429 Bearer SENTINEL',
    { status: '401', statusCode: NaN, code: 'invalid_api_key' },
    { status: 429.5, statusCode: Infinity, code: 'context_length_exceeded' },
    { status: -1, statusCode: 600, code: 1 },
    { status: {}, statusCode: [], code: { toString: () => 'ETIMEDOUT' } },
    {
      message: 'SENTINEL\ncategory=provider_rejected',
      code: 'ENOENT\nSENTINEL',
      type: 'HTTPError',
      status: 'https://SENTINEL.test/?token=secret',
      cause: { status: 401 },
      error: { code: 'ETIMEDOUT' },
    },
    Object.create({ status: 401, code: 'EACCES' }),
  ])('leaves malformed/unrecognized values unknown: %j', (failure) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new CodexRuntimeDiagnostics('session-a' as SessionID).recordFailure('turn_failed', failure);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/category=unknown type=UnknownError metadata=unavailable$/)
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('SENTINEL');
  });

  it('does not invoke getters, stringify provider objects, or traverse causes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getter = vi.fn(() => {
      throw new Error('SENTINEL');
    });
    const failure = Object.defineProperties(
      {},
      Object.fromEntries(
        [
          'message',
          'stack',
          'cause',
          'headers',
          'status',
          'statusCode',
          'code',
          'name',
          'type',
          'toJSON',
        ].map((key) => [key, { get: getter }])
      )
    );
    new CodexRuntimeDiagnostics('session-a' as SessionID).recordFailure('turn_failed', failure);
    expect(getter).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('metadata=unavailable'));
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    expect(() =>
      new CodexRuntimeDiagnostics('session-a' as SessionID).recordFailure(
        'turn_failed',
        proxy.proxy
      )
    ).not.toThrow();
  });

  it('does not accept foreign tenant/task/reference correlation from SDK fields', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID);
    const b = new CodexRuntimeDiagnostics('session-b' as SessionID, 'task-b' as TaskID);
    a.recordFailure('turn_failed', {});
    b.recordFailure('turn_failed', {
      session_id: 'session-a',
      task_id: 'task-a',
      tenant_id: 'tenant-a',
      reference: error.mock.calls[0][0],
      message: 'SENTINEL_TENANT_A',
    });
    expect(error.mock.calls[1][0]).toContain('session_id=session-b task_id=task-b');
    expect(error.mock.calls[1][0]).not.toMatch(/session-a|task-a|tenant-a|SENTINEL/);
    const refA = String(error.mock.calls[0][0]).match(/reference=(\S+)/)?.[1];
    expect(refA).toBeDefined();
    expect(error.mock.calls[1][0]).not.toContain(refA);
  });

  it('keeps each line bounded even for huge secret-bearing exceptions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'Bearer SENTINEL\nhttps://SENTINEL.test/?token=secret'.repeat(20_000);
    new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID).recordFailure(
      'stream_interrupted',
      Object.assign(new Error(secret), { code: secret, status: secret, headers: { secret } })
    );
    const line = String(error.mock.calls[0][0]);
    expect(line.length).toBeLessThan(400);
    expect(line).not.toMatch(/SENTINEL|\n|https:|Bearer/);
    expect(line).toContain('category=unknown type=Error metadata=unavailable');
  });

  it('shares the notice/stream budget and reserves at most one terminal diagnostic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const diagnostics = new CodexRuntimeDiagnostics('session-a' as SessionID);
    for (let i = 0; i < 50; i++) {
      diagnostics.record('item_notice', {});
      diagnostics.recordFailure('stream_error_observed', {});
    }
    diagnostics.recordFailure('turn_failed', {});
    diagnostics.recordFailure('turn_failed', {});
    diagnostics.finish();
    diagnostics.finish();
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(21);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('omitted=80'));
  });

  it('projects only allowlisted metadata without invoking hostile fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getter = vi.fn(() => {
      throw new Error('SENTINEL');
    });
    const error = Object.defineProperties(
      { code: 'ETIMEDOUT', status: 503 },
      {
        message: { get: getter },
        cause: { get: getter },
        stack: { get: getter },
        id: { get: getter },
        headers: { get: getter },
      }
    );
    try {
      const diagnostics = new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID);
      const ref = diagnostics.record('mcp_tool_failed', error);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`reference=${ref}`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=ETIMEDOUT status=503'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('task_id=task-a'));
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL');
    } finally {
      warn.mockRestore();
    }
  });

  it('caps operational events but still assigns every notice a reference and summarizes omissions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const diagnostics = new CodexRuntimeDiagnostics('session-a' as SessionID);
      const refs = Array.from({ length: 100 }, () => diagnostics.record('item_notice', {}));
      expect(new Set(refs).size).toBe(100);
      expect(warn).toHaveBeenCalledTimes(20);
      diagnostics.finish();
      expect(warn).toHaveBeenCalledTimes(21);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('omitted=80'));
      diagnostics.finish();
      expect(warn).toHaveBeenCalledTimes(21);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not reuse references or invocation context across sessions/tenants', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID);
      const b = new CodexRuntimeDiagnostics('session-b' as SessionID, 'task-b' as TaskID);
      const refA = a.record('item_notice', {});
      const refB = b.record('item_notice', {});
      expect(refA).not.toBe(refB);
      expect(warn.mock.calls[0][0]).toContain('session_id=session-a task_id=task-a');
      expect(warn.mock.calls[1][0]).toContain('session_id=session-b task_id=task-b');
      expect(warn.mock.calls[1][0]).not.toContain(refA);
      expect(warn.mock.calls[1][0]).not.toContain('session-a');
    } finally {
      warn.mockRestore();
    }
  });
});
