import type { Link } from '@agor-live/client';
import {
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';

const TEST_TIMESTAMP = '2026-07-01T00:00:00.000Z';

export function makeTestLink(overrides: Partial<Link> = {}): Link {
  const link = {
    link_id: 'link-1',
    branch_id: null,
    session_id: 'session-1',
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url: null,
    ref_uri: null,
    file_path: null,
    is_pinned: false,
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: TEST_TIMESTAMP,
    updated_at: TEST_TIMESTAMP,
    ...overrides,
  } as Link;
  return {
    ...link,
    target_key:
      overrides.target_key ??
      (link.url
        ? normalizeUrlTargetKey(link.url)
        : link.ref_uri
          ? normalizeRefTargetKey(link.ref_uri)
          : link.file_path
            ? normalizeFileTargetKey(link.file_path)
            : ''),
  };
}
