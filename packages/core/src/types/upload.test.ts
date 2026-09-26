import { describe, expect, it } from 'vitest';
import {
  getUploadPolicyErrorDefinition,
  resolveUploadServeType,
  UPLOAD_POLICY_ERROR_CONTRACT,
} from './upload';

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

describe('resolveUploadServeType', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])(
    'serves %s inline with its own type',
    (mime) => {
      expect(resolveUploadServeType(`${mime.toUpperCase()}; charset=binary`)).toEqual({
        contentType: mime,
        inline: true,
      });
    }
  );

  it.each([
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'text/javascript',
    'application/x-yaml',
    '',
    undefined,
    null,
  ])('never echoes %j; serves it as an octet-stream attachment', (mime) => {
    expect(resolveUploadServeType(mime)).toEqual({
      contentType: 'application/octet-stream',
      inline: false,
    });
  });
});
