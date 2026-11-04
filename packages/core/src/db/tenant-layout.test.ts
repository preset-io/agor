import { describe, expect, it } from 'vitest';
import { createCloneLayoutTransform } from './tenant-layout';

describe('createCloneLayoutTransform', () => {
  it('rewrites paths without losing number precision elsewhere in the row', () => {
    const repo =
      '{"repo_id":"r1","slug":"acme/app","data":{"local_path":"/old","meta":{"big":9007199254740993,"ratio":1.10}}}';
    const branch =
      '{"branch_id":"b1","repo_id":"r1","name":"main","data":{"path":"/old/main","custom_context":{"n":12345678901234567890}}}';
    const transform = createCloneLayoutTransform(
      { repoPath: (slug) => `/new/${slug}`, branchPath: (slug, name) => `/new/${slug}/${name}` },
      (name) => (name === 'repos' ? [repo] : [])
    );
    const [repoOut] = transform('repos', [repo]);
    const [branchOut] = transform('branches', [branch]);
    expect(repoOut).toContain('"big":9007199254740993');
    expect(repoOut).toContain('"ratio":1.10');
    expect(repoOut).toContain('"local_path":"/new/acme/app"');
    expect(branchOut).toContain('"n":12345678901234567890');
    expect(branchOut).toContain('"path":"/new/acme/app/main"');
  });
});
