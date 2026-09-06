import { describe, expect, it } from 'vitest';
import {
  BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS,
  EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS,
  EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
  resolveBranchFilesystemMaterializationBudget,
} from './constants';

describe('resolveBranchFilesystemMaterializationBudget', () => {
  it('uses the normal ten-minute attempt with credential settlement margin', () => {
    expect(resolveBranchFilesystemMaterializationBudget()).toEqual({
      attemptTimeoutMs: BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS,
      credentialLifetimeMs:
        BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS +
        EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
    });
  });

  it('shortens the persisted attempt to fit a hardened credential ceiling', () => {
    const ceilingMs = 5 * 60_000;
    expect(resolveBranchFilesystemMaterializationBudget(ceilingMs)).toEqual({
      attemptTimeoutMs: ceilingMs - EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
      credentialLifetimeMs: ceilingMs,
    });
  });

  it('caps credentials at the taskless token policy', () => {
    expect(resolveBranchFilesystemMaterializationBudget(24 * 60 * 60_000)).toEqual({
      attemptTimeoutMs: BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS,
      credentialLifetimeMs:
        BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS +
        EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
    });
    expect(EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS).toBeGreaterThan(
      BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS
    );
  });

  it('rejects a ceiling too short to preserve the minimum attempt and settlement margin', () => {
    expect(() => resolveBranchFilesystemMaterializationBudget(65_999)).toThrow(
      'too short for branch filesystem materialization'
    );
  });
});
