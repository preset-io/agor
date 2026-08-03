import { describe, expect, it } from 'vitest';
import { uploadMaterializationRelativePath } from './upload.js';

describe('upload materialization destination', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';

  it('uses the upload ref so duplicate filenames do not collide', () => {
    const first = uploadMaterializationRelativePath({
      sessionId,
      uploadRef: 'upl_00000000-0000-4000-8000-000000000002',
      filename: 'image.png',
    });
    const second = uploadMaterializationRelativePath({
      sessionId,
      uploadRef: 'upl_00000000-0000-4000-8000-000000000003',
      filename: 'image.png',
    });
    expect(first).not.toBe(second);
    expect(first).toContain('/upl_00000000-0000-4000-8000-000000000002/image.png');
  });

  it('keeps sanitization collisions separate and is deterministic for retries', () => {
    const input = {
      sessionId,
      uploadRef: 'upl_00000000-0000-4000-8000-000000000002',
      filename: '../same?.txt',
    };
    expect(uploadMaterializationRelativePath(input)).toBe(uploadMaterializationRelativePath(input));
    expect(uploadMaterializationRelativePath(input)).toMatch(/\/upl_[^/]+\/same_\.txt$/);
  });
});
