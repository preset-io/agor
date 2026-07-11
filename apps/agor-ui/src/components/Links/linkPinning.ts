import type { AgorClient, BranchID, Link, LinkCreate, SessionID } from '@agor-live/client';
import { getCompactLinkDisplayName, type LinkDisplayItem } from './linkDisplay';

export function canPersistLinkPin(item: LinkDisplayItem): boolean {
  return Boolean(
    item.linkId ||
      (item.url && item.href && item.navigation === 'external') ||
      (item.refUri && item.href)
  );
}

export function getLinkPinActionLabel(
  item: Pick<LinkDisplayItem, 'isPinned' | 'ownerScope'>,
  sessionDestination = 'session'
): string {
  if (item.ownerScope === 'branch') {
    return item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  }
  return item.isPinned ? `Unpin from ${sessionDestination}` : 'Pin in session';
}

export async function toggleLinkDisplayItemPinned(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  branchId?: string | null;
  sessionId?: string | null;
}): Promise<Link> {
  const { client, item } = args;
  if (item.linkId) {
    return (await client.service('links').patch(item.linkId, {
      is_pinned: !item.isPinned,
    })) as Link;
  }

  const owner =
    item.ownerScope === 'branch' && args.branchId
      ? { branch_id: args.branchId as BranchID, session_id: null }
      : item.ownerScope === 'session' && args.sessionId
        ? { branch_id: null, session_id: args.sessionId as SessionID }
        : null;
  const target =
    item.url && item.href && item.navigation === 'external'
      ? { url: item.url, ref_uri: null, file_path: null }
      : item.refUri && item.href
        ? { url: null, ref_uri: item.refUri, file_path: null }
        : null;
  if (!owner || !target) throw new Error('This link cannot be pinned from this view');

  const created = await client.service('links').create({
    ...owner,
    ...target,
    kind: item.kind ?? (item.url ? 'url' : 'internal'),
    source: 'manual',
    is_pinned: true,
    title: getCompactLinkDisplayName(item),
  } satisfies LinkCreate);
  return created as Link;
}
