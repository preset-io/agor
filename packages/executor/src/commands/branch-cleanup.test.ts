import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH_ARCHIVE_COMMAND, BRANCH_CLEANUP_COMMAND } from '@agor/core/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BranchCleanPayload } from '../payload-types';
import { handleBranchArchive, handleBranchClean } from './branch-cleanup';

function payload(cwd: string, command: string): BranchCleanPayload {
  return {
    command: BRANCH_CLEANUP_COMMAND,
    daemonUrl: 'http://127.0.0.1/fixture-only',
    sessionToken: 'fixture-only-token',
    params: {
      branchId: randomUUID(),
      cwd,
      operationId: randomUUID(),
      generation: 1,
      executionId: randomUUID(),
      deadlineAt: Date.now() + 5000,
      principalBranchAccess: 'write',
      cleanup: {
        command,
      },
    },
  };
}

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  )
);
afterEach(() => vi.unstubAllGlobals());

it('shares archive execution inline and returns no raw output for large output or partial failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-cleanup-executor-test-'));
  try {
    const command = `node -e 'require("node:fs").writeFileSync("result","done"); process.stdout.write("secret".repeat(200000)); process.stderr.write("private".repeat(200000)); process.exitCode=7'`;
    const request = payload(directory, command);
    const result = await handleBranchArchive({ ...request, command: BRANCH_ARCHIVE_COMMAND }, {});
    expect(result).toMatchObject({ success: false, error: { code: 'CLEANUP_COMMAND_FAILED' } });
    expect(JSON.stringify(result).length).toBeLessThan(512);
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
    expect(await readFile(join(directory, 'result'), 'utf8')).toBe('done');
    expect(await handleBranchClean(payload(directory, 'true'), {})).toMatchObject({
      success: true,
    });
    await writeFile(join(directory, 'keep'), 'retained');
    expect(
      await handleBranchArchive(
        {
          ...request,
          command: BRANCH_ARCHIVE_COMMAND,
          params: { ...request.params, cleanup: undefined },
        },
        {}
      )
    ).toEqual({ success: true });
    expect(await readFile(join(directory, 'keep'), 'utf8')).toBe('retained');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects preview, unsupervised execution, and a missing workspace without creating it', async () => {
  const directory = join(tmpdir(), `agor-cleanup-absent-${randomUUID()}`);
  const request = payload(directory, 'true');
  expect(await handleBranchClean(request, { dryRun: true })).toMatchObject({
    success: false,
    error: { code: 'CLEANUP_PREVIEW_UNSUPPORTED' },
  });
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 403 }));
  expect(await handleBranchClean(request, {})).toMatchObject({
    success: false,
    error: { code: 'CLEANUP_NOT_CLAIMED' },
  });
  expect(await handleBranchClean(request, {})).toMatchObject({
    success: false,
    error: { code: 'CLEANUP_COMMAND_FAILED' },
  });
  await expect(readFile(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not execute when claim delivery is rejected, and never reports success for a lost completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-cleanup-report-test-'));
  try {
    const request = payload(directory, 'printf done > result');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await handleBranchClean(request, {});
    await expect(readFile(join(directory, 'result'))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockRejectedValueOnce(new Error('fixture lost completion'));
    expect(await handleBranchClean(request, {})).toMatchObject({
      success: false,
      error: { code: 'CLEANUP_REPORT_UNKNOWN' },
    });
    expect(await readFile(join(directory, 'result'), 'utf8')).toBe('done');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('a timed-out custom command reports uncertainty rather than success or automatic retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-cleanup-timeout-test-'));
  try {
    const request = payload(directory, 'sleep 30');
    request.params.deadlineAt = Date.now() + 100;
    expect(await handleBranchClean(request, {})).toMatchObject({
      success: false,
      error: { code: 'CLEANUP_OUTCOME_UNKNOWN' },
    });
    const reports = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse(init!.body as string).action);
    expect(reports).toEqual(['claim', 'unknown']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
