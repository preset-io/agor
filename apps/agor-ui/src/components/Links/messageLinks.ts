import type { Link } from '@agor-live/client';

export function groupRenderableLinksByMessageId(links: readonly Link[]): Map<string, Link[]> {
  const byMessageId = new Map<string, Link[]>();
  for (const link of links) {
    if (!link.source_message_id) continue;
    const renderableUpload = link.source === 'upload' && Boolean(link.file_path);
    const renderableParsed = link.source === 'parsed' && Boolean(link.url || link.ref_uri);
    if (!renderableUpload && !renderableParsed) continue;
    const existing = byMessageId.get(link.source_message_id) ?? [];
    existing.push(link);
    byMessageId.set(link.source_message_id, existing);
  }
  return byMessageId;
}
