/** Files attached to a Teams channel message; the bot activity omits them, so they are read over Graph. */

import { createHash } from 'node:crypto';
import { TEAMS_CHANNEL_ID_PATTERN, type TeamsGatewayConfig } from '../../types/gateway';
import type { InboundFile, InboundSkippedFile } from '../connector';
import { readableMimeForFilename } from '../readable-files';
import { isTeamsFileDownloadUrl } from '../teams-service-url';
import {
  asRecord,
  authorizedJson,
  GRAPH_ORIGIN,
  GRAPH_SCOPE,
  graphChannelMessagesUrl,
  isTeamsRscDenied,
  markTeamsRscDenied,
  resolveTeamGroupId,
  TEAMS_CATCH_UP_RETRY,
  TEAMS_MESSAGE_ID,
  type TeamsGraphCacheScope,
  TeamsGraphHttpError,
  type TeamsGraphRuntime,
  type TeamsTeamReference,
  text,
} from './teams-graph';

const MAX_CHANNEL_FILES = 10;

export interface TeamsChannelFilesRequest {
  team: TeamsTeamReference;
  channelId: string;
  rootMessageId: string;
  messageId: string;
  filesEnabled: boolean;
  cacheScope?: TeamsGraphCacheScope | null;
  signal?: AbortSignal;
}

export interface TeamsChannelFilesResult {
  files: InboundFile[];
  skipped: InboundSkippedFile[];
}

function sharesUrl(contentUrl: string): string {
  const encoded = Buffer.from(contentUrl, 'utf8').toString('base64url');
  return `${GRAPH_ORIGIN}/v1.0/shares/u!${encoded}/driveItem`;
}

/** The decoded path of a SharePoint web URL, or null when it is not one. */
function sharePointPath(value: unknown): { origin: string; path: string } | null {
  if (!isTeamsFileDownloadUrl(value)) return null;
  try {
    const url = new URL(value as string);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    return path.split('/').some((segment) => segment === '..' || segment === '.')
      ? null
      : { origin: url.origin, path };
  } catch {
    return null;
  }
}

/** Every channel of a team shares one document library, so the file must sit under this channel's folder. */
function isUnderFolder(itemUrl: unknown, folder: { origin: string; path: string }): boolean {
  const item = sharePointPath(itemUrl);
  return !!item && item.origin === folder.origin && item.path.startsWith(`${folder.path}/`);
}

function isForbidden(error: unknown): boolean {
  return error instanceof TeamsGraphHttpError && (error.status === 403 || error.status === 401);
}

/** Readable files of one channel message as pre-authenticated SharePoint URLs, only from the channel's own folder; null when the message cannot be read. */
export async function fetchTeamsChannelMessageFiles(
  config: TeamsGatewayConfig,
  req: TeamsChannelFilesRequest,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<TeamsChannelFilesResult | null> {
  const { channelId, rootMessageId, messageId } = req;
  if (
    !TEAMS_CHANNEL_ID_PATTERN.test(channelId) ||
    !TEAMS_MESSAGE_ID.test(rootMessageId) ||
    !TEAMS_MESSAGE_ID.test(messageId)
  ) {
    throw new Error('Teams channel message coordinates are invalid');
  }
  const runtime: TeamsGraphRuntime = {
    fetchImpl: options.fetchImpl ?? fetch,
    config,
    cacheScope: req.cacheScope,
    signal: req.signal,
    retry: TEAMS_CATCH_UP_RETRY,
  };
  const result: TeamsChannelFilesResult = { files: [], skipped: [] };
  const groupId = await resolveTeamGroupId(runtime, req.team);
  if (isTeamsRscDenied(runtime, groupId)) return null;
  const channelUrl = graphChannelMessagesUrl(groupId, channelId);
  const messageUrl =
    rootMessageId === messageId
      ? `${channelUrl}/${encodeURIComponent(messageId)}`
      : `${channelUrl}/${encodeURIComponent(rootMessageId)}/replies/${encodeURIComponent(messageId)}`;
  let message: Record<string, unknown>;
  try {
    message = await authorizedJson(runtime, GRAPH_SCOPE, messageUrl);
  } catch (error) {
    if (error instanceof TeamsGraphHttpError && error.status === 403) {
      markTeamsRscDenied(runtime, groupId);
      return null;
    }
    throw error;
  }

  const candidates: Array<{ name: string; mimetype: string; contentUrl: string }> = [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const raw of attachments) {
    if (candidates.length + result.skipped.length >= MAX_CHANNEL_FILES) break;
    const attachment = asRecord(raw);
    if (attachment.contentType !== 'reference') continue;
    const name = (text(attachment.name) ?? 'attachment').slice(0, 200);
    const mimetype = readableMimeForFilename(name);
    const contentUrl = text(attachment.contentUrl);
    if (!mimetype) result.skipped.push({ name, reason: 'unsupported_type' });
    else if (!req.filesEnabled) result.skipped.push({ name, reason: 'files_disabled' });
    else if (!isTeamsFileDownloadUrl(contentUrl)) result.skipped.push({ name, reason: 'invalid' });
    else candidates.push({ name, mimetype, contentUrl });
  }
  if (candidates.length === 0) return result;
  const unreadable = () => {
    for (const { name } of candidates) result.skipped.push({ name, reason: 'channel_file' });
    return result;
  };

  let channelDriveId: string | null;
  let channelFolder: { origin: string; path: string } | null;
  try {
    const folder = await authorizedJson(
      runtime,
      GRAPH_SCOPE,
      `${GRAPH_ORIGIN}/v1.0/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/filesFolder`
    );
    channelDriveId = text(asRecord(folder.parentReference).driveId);
    channelFolder = sharePointPath(folder.webUrl);
  } catch (error) {
    if (isForbidden(error)) return unreadable();
    throw error;
  }
  if (!channelDriveId || !channelFolder) return unreadable();

  for (const [index, candidate] of candidates.entries()) {
    let item: Record<string, unknown>;
    try {
      item = await authorizedJson(runtime, GRAPH_SCOPE, sharesUrl(candidate.contentUrl));
    } catch (error) {
      if (!isForbidden(error) && !(error instanceof TeamsGraphHttpError && error.status === 404)) {
        throw error;
      }
      result.skipped.push({ name: candidate.name, reason: 'channel_file' });
      continue;
    }
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    const size = item.size;
    if (
      text(asRecord(item.parentReference).driveId) !== channelDriveId ||
      !isUnderFolder(item.webUrl, channelFolder) ||
      !item.file ||
      !isTeamsFileDownloadUrl(downloadUrl)
    ) {
      result.skipped.push({ name: candidate.name, reason: 'invalid' });
      continue;
    }
    result.files.push({
      id: createHash('sha256')
        .update(JSON.stringify([channelId, messageId, index]))
        .digest('hex')
        .slice(0, 16),
      name: candidate.name,
      mimetype: candidate.mimetype,
      size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : -1,
      url_private_download: downloadUrl,
    });
  }
  return result;
}
