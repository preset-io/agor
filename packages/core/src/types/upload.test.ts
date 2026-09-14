import { describe, expect, it } from 'vitest';
import { getUploadPolicyErrorDefinition, UPLOAD_POLICY_ERROR_CONTRACT } from './upload';

describe('upload policy error contract', () => {
  it('resolves the reviewed code/status pair', () => {
    expect(getUploadPolicyErrorDefinition('UNSUPPORTED_MEDIA_TYPE')).toEqual(
      UPLOAD_POLICY_ERROR_CONTRACT.unsupportedMediaType
    );
  });

  it('does not resolve an unknown policy code', () => {
    expect(getUploadPolicyErrorDefinition('UPLOAD_REJECTED')).toBeUndefined();
  });
});
