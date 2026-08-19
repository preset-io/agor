/** Provider-policy ingestion for explicitly admitted gateway attachments. */

import { Readable, Transform } from 'node:stream';
import type { InboundFile } from '@agor/core/gateway';
import { isDiscordAttachmentCdnUrl } from '@agor/core/gateway';
import type {
  BranchID,
  SessionID,
  TenantID,
  UploadMetadata,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';
import { buildUploadAttachmentPrompt } from '@agor/core/types';
import { createPinnedBinaryFetch, type PinnedBinaryResponse } from '@agor/core/utils/pinned-fetch';
import { ALLOWED_UPLOAD_MIME_TYPES, getUploadLimits } from './upload.js';
import { getUploadStagingStore } from './upload-staging.js';

export interface AttachmentIngestResult {
  uploads: UploadMetadata[];
  failed: number;
}

export type GatewayAttachmentProvider = 'slack' | 'discord';
export type GatewayAttachmentFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response | PinnedBinaryResponse>;

export const GATEWAY_ATTACHMENT_MAX_REDIRECT_HOPS = 3;
export const DISCORD_ATTACHMENT_FILE_DEADLINE_MS = 15_000;
export const DISCORD_ATTACHMENT_MESSAGE_DEADLINE_MS = 60_000;

class AttachmentPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AttachmentPolicyError';
  }
}

function policyFailure(code: string): never {
  throw new AttachmentPolicyError(code);
}

/** Slack credentials may only be sent to Slack's exact domain boundary. */
export function isAllowedSlackFileUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'slack.com' || host.endsWith('.slack.com');
  } catch {
    return false;
  }
}

function normalizeMime(rawMime: string): string {
  return rawMime.split(';')[0].trim().toLowerCase();
}

function isAllowedIngestMime(rawMime: string): boolean {
  const mime = normalizeMime(rawMime);
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) return false;
  return mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/json';
}

export function isIngestableFile(file: InboundFile): boolean {
  return isAllowedIngestMime(file.mimetype);
}

export function buildPromptWithAttachments(
  text: string,
  attachments: UploadMetadata[],
  options: { untrustedUserContext?: boolean } = {}
): string {
  return buildUploadAttachmentPrompt(
    text,
    attachments.map(({ ref, name, mimeType, size }) => ({ ref, filename: name, mimeType, size })),
    options
  );
}

function isNodeReadable(value: unknown): value is NodeJS.ReadableStream & { destroy?: () => void } {
  return !!value && typeof (value as NodeJS.ReadableStream).pipe === 'function';
}

function toNodeReadable(body: Response['body'] | NodeJS.ReadableStream): NodeJS.ReadableStream {
  return isNodeReadable(body) ? body : Readable.fromWeb(body as never);
}

async function discardBody(body: Response['body'] | NodeJS.ReadableStream | null): Promise<void> {
  if (!body) return;
  if (isNodeReadable(body)) {
    body.destroy?.();
    return;
  }
  const cancel = (body as { cancel?: () => Promise<void> }).cancel;
  if (typeof cancel === 'function') await cancel.call(body).catch(() => undefined);
}

function allowedUrl(
  provider: GatewayAttachmentProvider,
  file: InboundFile,
  value: string
): boolean {
  return provider === 'discord'
    ? isDiscordAttachmentCdnUrl(value, file.id as never, file.name)
    : isAllowedSlackFileUrl(value);
}

async function fetchFromAllowedHosts(args: {
  provider: GatewayAttachmentProvider;
  file: InboundFile;
  fetchImpl: GatewayAttachmentFetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response | PinnedBinaryResponse> {
  let url = args.file.url_private_download;
  for (let hop = 0; hop <= GATEWAY_ATTACHMENT_MAX_REDIRECT_HOPS; hop++) {
    if (!allowedUrl(args.provider, args.file, url)) policyFailure('url_rejected');
    const response = await args.fetchImpl(url, {
      ...(args.headers ? { headers: args.headers } : {}),
      redirect: 'manual',
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discardBody(response.body);
      if (!location) policyFailure('redirect_missing_location');
      try {
        url = new URL(location, url).toString();
      } catch {
        policyFailure('redirect_invalid');
      }
      continue;
    }
    return response;
  }
  policyFailure('redirect_limit');
}

function contentPrefixAllowed(mime: string, prefix: Buffer): boolean {
  if (mime === 'image/png')
    return (
      prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    );
  if (mime === 'image/jpeg')
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mime === 'image/gif') {
    const magic = prefix.subarray(0, 6).toString('ascii');
    return magic === 'GIF87a' || magic === 'GIF89a';
  }
  if (mime === 'image/webp')
    return (
      prefix.length >= 12 &&
      prefix.subarray(0, 4).toString('ascii') === 'RIFF' &&
      prefix.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  const trimmed = prefix
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (
    prefix.includes(0) ||
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<svg') ||
    trimmed.startsWith('%pdf-') ||
    prefix.subarray(0, 2).toString('binary') === 'MZ' ||
    prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    return false;
  }
  return mime !== 'application/json' || trimmed.startsWith('{') || trimmed.startsWith('[');
}

function createBodyPolicyTransform(args: {
  mime: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  total: { bytes: number };
  verifyContent: boolean;
}): Transform {
  let fileBytes = 0;
  const prefix: Buffer[] = [];
  let prefixBytes = 0;
  const textDecoder =
    args.verifyContent && (args.mime.startsWith('text/') || args.mime === 'application/json')
      ? new TextDecoder('utf-8', { fatal: true })
      : undefined;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      fileBytes += chunk.byteLength;
      args.total.bytes += chunk.byteLength;
      if (fileBytes > args.maxFileBytes) {
        callback(new AttachmentPolicyError('actual_file_bytes_exceeded'));
        return;
      }
      if (args.total.bytes > args.maxTotalBytes) {
        callback(new AttachmentPolicyError('actual_total_bytes_exceeded'));
        return;
      }
      if (prefixBytes < 512) {
        const take = Math.min(512 - prefixBytes, chunk.byteLength);
        prefix.push(chunk.subarray(0, take));
        prefixBytes += take;
      }
      try {
        textDecoder?.decode(chunk, { stream: true });
      } catch {
        callback(new AttachmentPolicyError('content_encoding_invalid'));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        textDecoder?.decode();
      } catch {
        callback(new AttachmentPolicyError('content_encoding_invalid'));
        return;
      }
      if (args.verifyContent && !contentPrefixAllowed(args.mime, Buffer.concat(prefix))) {
        callback(new AttachmentPolicyError('content_signature_mismatch'));
        return;
      }
      callback();
    },
  });
}

function safeFailureCode(error: unknown): string {
  return error instanceof AttachmentPolicyError ? error.code : 'provider_fetch_or_stage_failed';
}

/**
 * Download the safe image/text attachments on one already-admitted message.
 * Every failure is reduced to a content-free code and the prompt still admits.
 */
export async function ingestInboundAttachments(args: {
  files: InboundFile[];
  provider?: GatewayAttachmentProvider;
  botToken?: string;
  fetchImpl?: GatewayAttachmentFetch;
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
  store?: UploadStagingStore;
}): Promise<AttachmentIngestResult> {
  const provider = args.provider ?? 'slack';
  if (provider === 'slack' && !args.botToken) {
    throw new Error('Slack attachment ingestion requires a bot token');
  }
  const limits = getUploadLimits();
  const defaultFetch: GatewayAttachmentFetch =
    provider === 'discord'
      ? createPinnedBinaryFetch({
          timeoutMs: DISCORD_ATTACHMENT_FILE_DEADLINE_MS,
          maxBytes: limits.maxFileBytes,
        })
      : (fetch as GatewayAttachmentFetch);
  const fetchImpl = args.fetchImpl ?? defaultFetch;
  const store = args.store ?? getUploadStagingStore();
  const uploads: UploadMetadata[] = [];
  const total = { bytes: 0 };
  let declaredTotal = 0;
  let ingestableCount = 0;
  let failed = 0;
  const messageAbort = new AbortController();
  const messageTimer =
    provider === 'discord'
      ? setTimeout(() => messageAbort.abort(), DISCORD_ATTACHMENT_MESSAGE_DEADLINE_MS)
      : undefined;

  try {
    for (const [attachmentIndex, file] of args.files.entries()) {
      if (!isIngestableFile(file)) {
        if (provider === 'discord') {
          failed++;
          console.warn(
            `[gateway.attachments] provider=discord event=rejected attachment_index=${attachmentIndex} code=mime_unsupported`
          );
        }
        continue;
      }
      ingestableCount++;
      if (ingestableCount > limits.maxFiles) {
        failed++;
        console.warn(
          `[gateway.attachments] provider=${provider} event=rejected attachment_index=${attachmentIndex} code=file_count_exceeded`
        );
        continue;
      }
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > limits.maxFileBytes ||
        declaredTotal + file.size > limits.maxTotalBytes
      ) {
        failed++;
        console.warn(
          `[gateway.attachments] provider=${provider} event=rejected attachment_index=${attachmentIndex} code=declared_bytes_exceeded`
        );
        continue;
      }
      declaredTotal += file.size;
      if (!allowedUrl(provider, file, file.url_private_download)) {
        failed++;
        console.warn(
          `[gateway.attachments] provider=${provider} event=rejected attachment_index=${attachmentIndex} code=url_rejected`
        );
        continue;
      }

      const fileAbort = new AbortController();
      const abortFile = () => fileAbort.abort();
      messageAbort.signal.addEventListener('abort', abortFile, { once: true });
      const fileTimer =
        provider === 'discord'
          ? setTimeout(() => fileAbort.abort(), DISCORD_ATTACHMENT_FILE_DEADLINE_MS)
          : undefined;
      try {
        if (messageAbort.signal.aborted) policyFailure('message_deadline');
        const response = await fetchFromAllowedHosts({
          provider,
          file,
          fetchImpl,
          ...(provider === 'slack'
            ? { headers: { Authorization: `Bearer ${args.botToken}` } }
            : {}),
          ...(provider === 'discord' ? { signal: fileAbort.signal } : {}),
        });
        if (!response.ok) {
          await discardBody(response.body);
          policyFailure('provider_http_rejected');
        }
        const declaredMime = normalizeMime(file.mimetype);
        const responseMime = normalizeMime(response.headers.get('content-type') ?? '');
        if (
          !isAllowedIngestMime(declaredMime) ||
          !isAllowedIngestMime(responseMime) ||
          (provider === 'discord' && declaredMime !== responseMime)
        ) {
          await discardBody(response.body);
          policyFailure('mime_mismatch');
        }
        const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
        if (
          (Number.isFinite(contentLength) &&
            (contentLength < 0 ||
              contentLength > limits.maxFileBytes ||
              total.bytes + contentLength > limits.maxTotalBytes)) ||
          !response.body
        ) {
          await discardBody(response.body);
          policyFailure(response.body ? 'response_bytes_exceeded' : 'response_body_missing');
        }
        const source = toNodeReadable(response.body);
        const policy = createBodyPolicyTransform({
          mime: responseMime,
          maxFileBytes: limits.maxFileBytes,
          maxTotalBytes: limits.maxTotalBytes,
          total,
          verifyContent: provider === 'discord',
        });
        source.on('error', (error) => policy.destroy(error));
        policy.on('error', () => {
          if (isNodeReadable(source)) source.destroy?.();
        });
        source.pipe(policy);
        const staged = await store.stage({
          owner: {
            tenantId: args.tenantId,
            sessionId: args.sessionId,
            branchId: args.branchId,
            createdBy: args.createdBy,
          },
          name: `${file.id}_${file.name}`,
          mimeType: responseMime,
          provenance: provider === 'discord' ? 'gateway-discord' : 'gateway-slack',
          body: policy,
          sizeHint: Number.isFinite(contentLength) ? contentLength : file.size,
        });
        uploads.push(staged);
      } catch (error) {
        failed++;
        console.warn(
          `[gateway.attachments] provider=${provider} event=failed attachment_index=${attachmentIndex} code=${safeFailureCode(error)}`
        );
      } finally {
        if (fileTimer) clearTimeout(fileTimer);
        messageAbort.signal.removeEventListener('abort', abortFile);
      }
    }
  } finally {
    if (messageTimer) clearTimeout(messageTimer);
  }
  return { uploads, failed };
}
