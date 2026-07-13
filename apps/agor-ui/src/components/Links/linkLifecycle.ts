import type {
  AgorClient,
  BranchID,
  Link,
  LinkCreate,
  LinkKind,
  LinkPatch,
  SessionID,
} from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';
import { ensurePersistedLink } from './linkPinning';
import {
  LINK_FORM_COPY,
  LINK_KIND,
  LINK_LIFECYCLE_ERROR,
  LINK_OWNER_SCOPE,
  LINK_SERVICE,
  LINK_SOURCE,
  LINK_TARGET,
  LINK_UNAVAILABLE_REASON,
} from './linkUiConstants';

export interface ManualLinkDraft {
  title?: string | null;
  target: string;
  isPinned?: boolean;
}

export function getManualLinkTarget(
  target: string
):
  | { kind: LinkKind; url: string; ref_uri: null; file_path: null }
  | { kind: typeof LINK_KIND.knowledge; url: null; ref_uri: string; file_path: null } {
  const value = target.trim();
  if (value.toLowerCase().startsWith(LINK_TARGET.knowledgePrefix)) {
    return { kind: LINK_KIND.knowledge, url: null, ref_uri: value, file_path: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(LINK_FORM_COPY.targetFormat);
  }
  if (
    parsed.protocol !== LINK_TARGET.httpProtocol &&
    parsed.protocol !== LINK_TARGET.httpsProtocol
  ) {
    throw new Error(LINK_FORM_COPY.targetProtocol);
  }

  const pathname = parsed.pathname;
  const kind: LinkKind =
    parsed.hostname.toLowerCase() === LINK_TARGET.githubHost &&
    /\/issues\/\d+(?:\/|$)/i.test(pathname)
      ? LINK_KIND.issue
      : parsed.hostname.toLowerCase() === LINK_TARGET.githubHost &&
          /\/pull\/\d+(?:\/|$)/i.test(pathname)
        ? LINK_KIND.pullRequest
        : LINK_KIND.url;
  return { kind, url: parsed.toString(), ref_uri: null, file_path: null };
}

function titleValue(title?: string | null): string | null {
  const value = title?.trim();
  return value || null;
}

export async function createManualLink(args: {
  client: AgorClient;
  branchId?: string | null;
  sessionId?: string | null;
  draft: ManualLinkDraft;
}): Promise<Link> {
  const owner = args.branchId
    ? { branch_id: args.branchId as BranchID, session_id: null }
    : args.sessionId
      ? { branch_id: null, session_id: args.sessionId as SessionID }
      : null;
  if (!owner) throw new Error(LINK_LIFECYCLE_ERROR.ownerRequired);

  return args.client.service(LINK_SERVICE).create({
    ...owner,
    ...getManualLinkTarget(args.draft.target),
    source: LINK_SOURCE.manual,
    title: titleValue(args.draft.title),
    is_pinned: args.draft.isPinned ?? false,
  } satisfies LinkCreate) as Promise<Link>;
}

export function canEditLinkTarget(item: LinkDisplayItem): boolean {
  return Boolean(
    item.linkId &&
      item.source === LINK_SOURCE.manual &&
      !item.filePath &&
      item.kind !== LINK_KIND.internal
  );
}

export async function updateLinkDisplayItem(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  branchId?: string | null;
  sessionId?: string | null;
  title?: string | null;
  target?: string;
}): Promise<Link> {
  const linkId =
    args.item.linkId ??
    (
      await ensurePersistedLink({
        client: args.client,
        item: args.item,
        branchId: args.branchId,
        sessionId: args.sessionId,
      })
    ).link_id;
  const patch: LinkPatch = { title: titleValue(args.title) };
  if (args.target !== undefined) Object.assign(patch, getManualLinkTarget(args.target));
  return args.client.service(LINK_SERVICE).patch(linkId, patch) as Promise<Link>;
}

export async function saveLinkToBranch(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  branchId: string;
}): Promise<Link> {
  const target = args.item.url
    ? { url: args.item.url, ref_uri: null, file_path: null }
    : args.item.refUri && args.item.kind === LINK_KIND.knowledge
      ? { url: null, ref_uri: args.item.refUri, file_path: null }
      : null;
  if (!target) throw new Error(LINK_LIFECYCLE_ERROR.branchSaveTarget);

  return args.client.service(LINK_SERVICE).create({
    branch_id: args.branchId as BranchID,
    session_id: null,
    ...target,
    kind: args.item.kind ?? (args.item.url ? LINK_KIND.url : LINK_KIND.knowledge),
    source: LINK_SOURCE.manual,
    is_pinned: false,
    title: args.item.title?.trim() || null,
  } satisfies LinkCreate) as Promise<Link>;
}

export function getBranchSaveState(args: {
  item: LinkDisplayItem;
  branchLinks: readonly Link[];
  available?: boolean;
}): { canSave: boolean; reason: string | null } {
  if (!args.available) return { canSave: false, reason: LINK_UNAVAILABLE_REASON.disconnected };
  if (args.item.ownerScope === LINK_OWNER_SCOPE.branch) {
    return { canSave: false, reason: LINK_UNAVAILABLE_REASON.branchOwned };
  }
  if (args.branchLinks.some((link) => link.target_key === args.item.targetKey)) {
    return { canSave: false, reason: LINK_UNAVAILABLE_REASON.branchOwned };
  }
  if (args.item.filePath || args.item.source === LINK_SOURCE.upload) {
    return { canSave: false, reason: LINK_UNAVAILABLE_REASON.fileLifetime };
  }
  if (args.item.kind === LINK_KIND.internal) {
    return { canSave: false, reason: LINK_UNAVAILABLE_REASON.internalAccess };
  }
  if (!args.item.url && !(args.item.refUri && args.item.kind === LINK_KIND.knowledge)) {
    return { canSave: false, reason: LINK_UNAVAILABLE_REASON.missingTarget };
  }
  return { canSave: true, reason: null };
}
