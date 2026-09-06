import { describe, expect, it } from 'vitest';
import {
  environmentLifecycleExecutorCommandId,
  gatewaySlackUploadExecutorCommandId,
  parseEnvironmentLifecycleExecutorCommandId,
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
});
