import type { AgorClient, BranchID, Link, LinkCreate, SessionID } from '@agor-live/client';
import { getCompactLinkDisplayName, type LinkDisplayItem } from './linkDisplay';
import {
  LINK_ACTION_LABEL,
  LINK_KIND,
  LINK_LIFECYCLE_ERROR,
  LINK_OWNER_SCOPE,
  LINK_SERVICE,
  LINK_SOURCE,
} from './linkUiConstants';

export function canPersistLinkPin(item: LinkDisplayItem): boolean {
  return Boolean(
    item.linkId ||
      (item.url && item.href && item.navigation === 'external') ||
      (item.refUri && item.href)
  );
}

export function getLinkPinActionLabel(
  item: Pick<LinkDisplayItem, 'category' | 'isPinned' | 'name'>,
  options: { available?: boolean } = {}
): string {
  const name = getCompactLinkDisplayName(item);
  const action = item.isPinned ? LINK_ACTION_LABEL.unpin : LINK_ACTION_LABEL.pin;
  return options.available === false ? `${action} unavailable for ${name}` : `${action} ${name}`;
}

export async function toggleLinkDisplayItemPinned(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  branchId?: string | null;
  sessionId?: string | null;
}): Promise<Link> {
  const { client, item } = args;
  if (item.linkId) {
    return (await client.service(LINK_SERVICE).patch(item.linkId, {
      is_pinned: !item.isPinned,
    })) as Link;
  }

  return ensurePersistedLink({
    ...args,
    isPinned: true,
  });
}

/**
 * Materialize display-only branch metadata (for example the canonical issue or
 * pull request) before an operation that requires a durable Link ID. Keeping
 * this in one place prevents pinning, editing, and save flows from developing
 * different hidden prerequisites.
 */
export async function ensurePersistedLink(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  branchId?: string | null;
  sessionId?: string | null;
  isPinned?: boolean;
}): Promise<Link> {
  const { client, item } = args;
  if (item.linkId) {
    return client.service(LINK_SERVICE).get(item.linkId) as Promise<Link>;
  }

  const owner =
    item.ownerScope === LINK_OWNER_SCOPE.branch && args.branchId
      ? { branch_id: args.branchId as BranchID, session_id: null }
      : item.ownerScope === LINK_OWNER_SCOPE.session && args.sessionId
        ? { branch_id: null, session_id: args.sessionId as SessionID }
        : null;
  const target =
    item.url && item.href && item.navigation === 'external'
      ? { url: item.url, ref_uri: null, file_path: null }
      : item.refUri && item.href
        ? { url: null, ref_uri: item.refUri, file_path: null }
        : null;
  if (!owner || !target) throw new Error(LINK_LIFECYCLE_ERROR.persistenceUnavailable);

  const created = await client.service(LINK_SERVICE).create({
    ...owner,
    ...target,
    kind: item.kind ?? (item.url ? LINK_KIND.url : LINK_KIND.internal),
    source: LINK_SOURCE.manual,
    is_pinned: args.isPinned ?? item.isPinned,
    title: null,
  } satisfies LinkCreate);
  return created as Link;
}
