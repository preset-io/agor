import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentLifecyclePayload } from '../payload-types';
import {
  deliverCompletionReport,
  EnvironmentReportError,
  handleEnvironmentAttempt,
  isRetryableReportError,
} from './environment-attempt';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(command: string) {
  const directory = await mkdtemp(join(tmpdir(), 'agor-attempt-test-'));
  directories.push(directory);
  const payload: EnvironmentLifecyclePayload = {
    command: 'environment.lifecycle',
    daemonUrl: 'https://any-replica.example.test',
    sessionToken: 'fake',
    params: {
      branchId: '019f0000-0000-7000-8000-00000000e002',
      branchPath: directory,
      action: 'start',
      startCommand: command,
      attempt: {
        id: '019f0000-0000-7000-8000-00000000e003',
        claimDeadline: new Date(Date.now() + 10000).toISOString(),
        commandDeadline: new Date(Date.now() + 10000).toISOString(),
        resultDeadline: new Date(Date.now() + 12000).toISOString(),
        externalJobDeadlineMs: 485000,
      },
    },
  };
  const reports: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    reports.push(JSON.parse(options.body as string));
    return new Response(
      JSON.stringify({
        command_deadline: payload.params.attempt.commandDeadline,
        result_deadline: payload.params.attempt.resultDeadline,
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { payload, reports, fetchMock, directory };
}
describe('executor-owned attempt protocol', () => {
  it('reports invalid extra URL properties immediately instead of retrying an unacceptable result', async () => {
    const h = await fixture(
      `printf '%s' '{"access_urls":[{"name":"Preview","url":"https://preview.example.test","extra":true}]}' > "$AGOR_ENVIRONMENT_RESULT_FILE"`
    );
    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: false });
    expect(h.reports.filter((report) => report.kind === 'result')).toHaveLength(1);
    expect(h.reports.at(-1)).toMatchObject({
      outcome: 'unknown',
      message: expect.stringContaining('invalid'),
    });
  });

  it('does not execute after a denied or lost claim acknowledgement', async () => {
    for (const lost of [false, true]) {
      const h = await fixture('touch must-not-exist');
      if (lost) h.fetchMock.mockRejectedValueOnce(new Error('lost response'));
      else h.fetchMock.mockResolvedValueOnce(new Response('', { status: 409 }));
      await expect(handleEnvironmentAttempt(h.payload)).rejects.toThrow();
      await expect(readFile(join(h.directory, 'must-not-exist'))).rejects.toThrow();
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
    }
  });
  it('reports bounded output and remote URLs, retrying only delivery after a lost result response', async () => {
    const h = await fixture(
      `printf x >> executions; printf '{"access_urls":[{"name":"Preview","url":"https://preview.example.test"}]}' > "$AGOR_ENVIRONMENT_RESULT_FILE"; node -e 'process.stdout.write("x".repeat(100000))'`
    );
    const implementation = h.fetchMock.getMockImplementation()!;
    let lost = false;
    h.fetchMock.mockImplementation(async (...args) => {
      const response = await implementation(...args);
      if (!lost && JSON.parse(args[1].body as string).kind === 'result') {
        lost = true;
        throw new Error('lost result acknowledgement');
      }
      return response;
    });
    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: true });
    expect(await readFile(join(h.directory, 'executions'), 'utf8')).toBe('x');
    const results = h.reports.filter((r) => r.kind === 'result');
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      outcome: 'succeeded',
      truncated: true,
      lifecycle_result: { app: 'https://preview.example.test/' },
    });
    expect(Buffer.byteLength(results[0]!.output as string)).toBeLessThanOrEqual(32768);
  });
  it.each(['javascript:alert(1)', 'https://user:password@example.test'])(
    'rejects unsafe result URLs without claiming provider failure or success: %s',
    async (url) => {
      const h = await fixture(
        `printf '%s' '${JSON.stringify({ access_urls: [{ name: 'Unsafe', url }] })}' > "$AGOR_ENVIRONMENT_RESULT_FILE"`
      );
      expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: false });
      expect(h.reports.at(-1)).toMatchObject({ kind: 'result', outcome: 'unknown' });
      expect(h.reports.at(-1)).not.toHaveProperty('access_urls');
    }
  );

  it('parses chunk-split stdout control independently from unterminated stderr', async () => {
    const script = [
      "process.stderr.write('warning without newline')",
      "process.stdout.write('AGOR_ENVIRON')",
      'setTimeout(() => process.stdout.write(\'MENT_RESULT={\\"app\\":\\"https://preview.example.test\\",\\"health\\":\\"https://preview.example.test/health\\"}\\n\'), 5)',
    ].join(';');
    const h = await fixture(`node -e ${JSON.stringify(script)}`);

    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: true });
    expect(h.reports.at(-1)).toMatchObject({
      kind: 'result',
      outcome: 'succeeded',
      output: 'warning without newline',
      lifecycle_result: {
        app: 'https://preview.example.test/',
        health: 'https://preview.example.test/health',
      },
    });
  });

  it('never accepts a control-looking stderr line as a result', async () => {
    const script =
      'process.stderr.write(\'AGOR_ENVIRONMENT_RESULT={\\"app\\":\\"https://stderr.example.test\\"}\\n\')';
    const h = await fixture(`node -e ${JSON.stringify(script)}`);

    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: true });
    expect(h.reports.at(-1)).not.toHaveProperty('lifecycle_result');
    expect(h.reports.at(-1)?.output).toContain('stderr.example.test');
  });

  it('stops at a terminal 4xx result rejection instead of storming the daemon', async () => {
    const h = await fixture('true');
    const implementation = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (...args) => {
      // Simulate a daemon that rejects a superseded attempt with a coded 409.
      if (JSON.parse(args[1].body as string).kind === 'result')
        return new Response('{"name":"Conflict"}', { status: 409 });
      return implementation(...args);
    });
    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({
      success: false,
      error: {
        code: 'ENVIRONMENT_REPORT_LOST',
        message: expect.stringContaining('rejected by the daemon'),
      },
    });
    // The storm metric: exactly one result delivery is attempted, not ~500.
    const resultSends = h.fetchMock.mock.calls.filter(
      (call) => JSON.parse(call[1].body as string).kind === 'result'
    );
    expect(resultSends).toHaveLength(1);
  });

  it('treats a 2xx result delivery with an unreadable body as delivered, not a storm', async () => {
    const h = await fixture('true');
    const implementation = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (...args) => {
      // Daemon recorded the result and returned 200, but the ack body is mangled.
      if (JSON.parse(args[1].body as string).kind === 'result')
        return new Response('<<not json>>', { status: 200 });
      return implementation(...args);
    });
    expect(await handleEnvironmentAttempt(h.payload)).toMatchObject({ success: true });
    const resultSends = h.fetchMock.mock.calls.filter(
      (call) => JSON.parse(call[1].body as string).kind === 'result'
    );
    expect(resultSends).toHaveLength(1);
  });
});

describe('environment report delivery retry policy', () => {
  it('treats only the daemon rejections (400/403/409) as terminal; everything else retries', () => {
    // The daemon's deliberate, deterministic rejections — never succeed on retry.
    expect(isRetryableReportError(new EnvironmentReportError('stale', 409))).toBe(false);
    expect(isRetryableReportError(new EnvironmentReportError('bad input', 400))).toBe(false);
    expect(isRetryableReportError(new EnvironmentReportError('forbidden', 403))).toBe(false);
    // Transient: server errors and overload.
    expect(isRetryableReportError(new EnvironmentReportError('server', 500))).toBe(true);
    expect(isRetryableReportError(new EnvironmentReportError('unavailable', 503))).toBe(true);
    expect(isRetryableReportError(new EnvironmentReportError('request timeout', 408))).toBe(true);
    expect(isRetryableReportError(new EnvironmentReportError('too many requests', 429))).toBe(true);
    // Transient: a not-yet-ready replica during rollout answers 401/404.
    expect(isRetryableReportError(new EnvironmentReportError('unauthorized', 401))).toBe(true);
    expect(isRetryableReportError(new EnvironmentReportError('not found', 404))).toBe(true);
    // Transient: status-less network/timeout fault.
    expect(isRetryableReportError(new Error('socket hang up'))).toBe(true);
  });

  it('does not retry a terminal 4xx rejection — one attempt, no sleep, no storm', async () => {
    const send = vi.fn(async () => {
      throw new EnvironmentReportError('Environment report rejected (HTTP 409)', 409);
    });
    const sleep = vi.fn(async () => undefined);
    const outcome = await deliverCompletionReport(send, 1_000_000, { now: () => 0, sleep });
    expect(outcome).toBe('rejected');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries transient failures with exponential backoff, not once per second', async () => {
    let clock = 0;
    const send = vi.fn(async () => {
      throw new EnvironmentReportError('Environment report rejected (HTTP 503)', 503);
    });
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    // ~8.5 min — the observed storm window; fixed 1s retries would be ~510 sends.
    const outcome = await deliverCompletionReport(send, 510_000, { now: () => clock, sleep });
    expect(outcome).toBe('exhausted');
    const waits = sleep.mock.calls.map((call) => call[0] as number);
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30000);
    expect(send.mock.calls.length).toBeLessThan(40);
  });

  it('retries a 429 (rate limit) rather than dropping the result as terminal', async () => {
    let clock = 0;
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new EnvironmentReportError('Environment report rejected (HTTP 429)', 429)
      )
      .mockResolvedValueOnce({ command_deadline: 'x', result_deadline: 'y' });
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const outcome = await deliverCompletionReport(send, 1_000_000, { now: () => clock, sleep });
    expect(outcome).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns delivered as soon as a retried transient failure is accepted', async () => {
    let clock = 0;
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new EnvironmentReportError('Environment report rejected (HTTP 500)', 500)
      )
      .mockResolvedValueOnce({ command_deadline: 'x', result_deadline: 'y' });
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const outcome = await deliverCompletionReport(send, 1_000_000, { now: () => clock, sleep });
    expect(outcome).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
