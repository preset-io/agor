import { describe, expect, it } from 'vitest';
import {
  environmentLifecycleExecutorCommandId,
  gatewaySlackUploadExecutorCommandId,
  gitBranchAddExecutorCommandId,
  parseEnvironmentLifecycleExecutorCommandId,
  parseGitBranchAddExecutorCommandId,
  uploadMaterializeExecutorCommandId,
} from './executor-command-ids.js';

describe('executor data-plane command identities', () => {
  it('binds every mutable resource component without delimiter ambiguity', () => {
    expect(uploadMaterializeExecutorCommandId('session:a', 'upl_ref')).toBe(
      'upload.materialize:session%3Aa:upl_ref'
    );
    expect(gatewaySlackUploadExecutorCommandId('gateway:a', 'channel:b')).toBe(
      'gateway.slack-file-upload:gateway%3Aa:channel%3Ab'
    );
  });

  it('round-trips an exact environment lifecycle generation', () => {
    const commandId = environmentLifecycleExecutorCommandId('start', 42);
    expect(commandId).toBe('environment-start:42');
    expect(parseEnvironmentLifecycleExecutorCommandId(commandId)).toEqual({
      action: 'start',
      generation: 42,
    });
    expect(parseEnvironmentLifecycleExecutorCommandId('environment-start')).toBeNull();
    expect(parseEnvironmentLifecycleExecutorCommandId('environment-start:4x')).toBeNull();
  });

  it('round-trips an exact branch materialization attempt', () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440004';
    expect(gitBranchAddExecutorCommandId(attemptId)).toBe(`git.branch.add:${attemptId}`);
    expect(parseGitBranchAddExecutorCommandId(`git.branch.add:${attemptId}`)).toBe(attemptId);
    expect(parseGitBranchAddExecutorCommandId('git.branch.add')).toBeNull();
  });
});
