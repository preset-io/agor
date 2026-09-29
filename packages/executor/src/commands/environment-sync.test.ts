import { describe, expect, it } from 'vitest';
import type { EnvironmentSyncPayload } from '../payload-types.js';
import { handleEnvironmentSync } from './environment.js';

const desiredRevision = 'a'.repeat(40);

function payload(appliedRevision: string): EnvironmentSyncPayload {
  return {
    command: 'environment.sync',
    sessionToken: 'test-token',
    params: {
      branchId: '550e8400-e29b-41d4-a716-446655440000',
      branchPath: process.cwd(),
      syncCommand: `printf '%s\\n' 'AGOR_ENVIRONMENT_RESULT={"applied_revision":"${appliedRevision}"}'`,
      desiredRevision,
      commandDeadline: new Date(Date.now() + 10_000).toISOString(),
    },
  };
}

describe('environment.sync executor', () => {
  it('accepts a matching exact revision acknowledgement', async () => {
    expect(await handleEnvironmentSync(payload(desiredRevision), {})).toMatchObject({
      success: true,
      data: { appliedRevision: desiredRevision },
    });
  });

  it('rejects a different revision even when the command exits successfully', async () => {
    expect(await handleEnvironmentSync(payload('b'.repeat(40)), {})).toMatchObject({
      success: false,
      error: { code: 'ENVIRONMENT_SYNC_FAILED' },
    });
  });
});
