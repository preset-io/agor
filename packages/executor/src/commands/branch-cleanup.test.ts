import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXECUTOR_RESPONSE_PROTOCOL } from '@agor/core/executor-protocol';
import { BRANCH_ARCHIVE_COMMAND, BRANCH_CLEANUP_COMMAND } from '@agor/core/types';
import { expect, it } from 'vitest';
import type { BranchCleanPayload } from '../payload-types';
import { handleBranchArchive, handleBranchClean } from './branch-cleanup';

function payload(cwd: string, command: string): BranchCleanPayload {
  return {
    command: BRANCH_CLEANUP_COMMAND,
    executorMode: 'request',
    executorResponse: {
      protocol: EXECUTOR_RESPONSE_PROTOCOL,
      profile: 'terminal',
      requestId: randomUUID(),
      url: 'http://127.0.0.1/fixture-only',
      token: 'test-only-token'.repeat(3),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      maxResponseBytes: 4096,
    },
    params: {
      branchId: randomUUID(),
      cwd,
      principalBranchAccess: 'write',
      cleanup: {
        operationId: randomUUID(),
        generation: 1,
        policyVersion: 'fixture',
        command,
      },
    },
  };
}

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
  expect(await handleBranchClean({ ...request, executorMode: undefined }, {})).toMatchObject({
    success: false,
    error: { code: 'CLEANUP_SUPERVISION_REQUIRED' },
  });
  expect(await handleBranchClean(request, {})).toMatchObject({
    success: false,
    error: { code: 'CLEANUP_WORKSPACE_UNAVAILABLE' },
  });
  await expect(readFile(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
