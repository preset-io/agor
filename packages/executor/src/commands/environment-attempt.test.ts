import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentLifecyclePayload } from '../payload-types';
import { handleEnvironmentAttempt } from './environment-attempt';

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
        externalJobDeadlineMs: 365000,
      },
    },
  };
  const reports: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    reports.push(JSON.parse(options.body as string));
    return new Response(
      JSON.stringify({
        command_deadline: payload.params.attempt!.commandDeadline,
        result_deadline: payload.params.attempt!.resultDeadline,
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { payload, reports, fetchMock, directory };
}
describe('executor-owned attempt protocol', () => {
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
      access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
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
});
