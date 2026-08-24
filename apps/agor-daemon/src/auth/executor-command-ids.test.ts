import { describe, expect, it } from 'vitest';
import {
  gatewaySlackUploadExecutorCommandId,
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
});
