import { describe, expect, it } from 'vitest';
import { isExternalFileBackedLinkMutation } from './links-hooks';

describe('isExternalFileBackedLinkMutation', () => {
  it('rejects external upload/file-backed link payloads', () => {
    expect(isExternalFileBackedLinkMutation({ file_path: '/tmp/upload.png' })).toBe(true);
    expect(isExternalFileBackedLinkMutation({ source: 'upload' })).toBe(true);
    expect(isExternalFileBackedLinkMutation({ kind: 'image' })).toBe(true);
    expect(isExternalFileBackedLinkMutation({ kind: 'document' })).toBe(true);
  });

  it('allows external URL/ref links and metadata-only patches', () => {
    expect(
      isExternalFileBackedLinkMutation({
        kind: 'url',
        source: 'manual',
        url: 'https://example.com',
      })
    ).toBe(false);
    expect(
      isExternalFileBackedLinkMutation({
        kind: 'kb_ref',
        source: 'manual',
        ref_uri: 'agor://kb/team/runbook.md',
      })
    ).toBe(false);
    expect(isExternalFileBackedLinkMutation({ title: 'Renamed upload' })).toBe(false);
  });
});
