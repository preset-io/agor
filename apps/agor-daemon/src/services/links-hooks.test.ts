import { describe, expect, it } from 'vitest';
import {
  getExternalLinkProvenanceMutationError,
  isExternalFileBackedLinkMutation,
  isExternalInternalLinkMutation,
} from './links-hooks';

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
    expect(
      isExternalFileBackedLinkMutation({
        kind: 'internal',
        source: 'manual',
        ref_uri: 'agor://session/01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        target_object_type: 'session',
        target_object_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
      })
    ).toBe(false);
    expect(isExternalFileBackedLinkMutation({ title: 'Renamed upload' })).toBe(false);
    expect(isExternalFileBackedLinkMutation({ is_pinned: true })).toBe(false);
  });
});

describe('isExternalInternalLinkMutation', () => {
  it('rejects internal kinds and explicit object target fields', () => {
    expect(isExternalInternalLinkMutation({ kind: 'internal' })).toBe(true);
    expect(isExternalInternalLinkMutation({ target_object_type: 'session' })).toBe(true);
    expect(isExternalInternalLinkMutation({ target_object_id: null })).toBe(true);
  });

  it('allows public and metadata-only payloads', () => {
    expect(isExternalInternalLinkMutation({ kind: 'url', url: 'https://example.com' })).toBe(false);
    expect(
      isExternalInternalLinkMutation({ kind: 'kb_ref', ref_uri: 'agor://kb/team/runbook.md' })
    ).toBe(false);
    expect(isExternalInternalLinkMutation({ title: 'Updated title' })).toBe(false);
  });
});

describe('getExternalLinkProvenanceMutationError', () => {
  it('allows only manual provenance on externally created links', () => {
    expect(getExternalLinkProvenanceMutationError({ source: 'manual' }, 'create')).toBeNull();
    expect(getExternalLinkProvenanceMutationError({ source: 'parsed' }, 'create')).toMatch(
      /source 'manual'/
    );
  });

  it('keeps parsed/upload attribution server-managed', () => {
    expect(
      getExternalLinkProvenanceMutationError(
        { source_message_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' },
        'create'
      )
    ).toMatch(/server-managed/);
    expect(getExternalLinkProvenanceMutationError({ source: 'parsed' }, 'patch')).toMatch(
      /immutable/
    );
    expect(getExternalLinkProvenanceMutationError({ source_message_id: null }, 'patch')).toMatch(
      /server-managed/
    );
  });
});
