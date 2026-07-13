import type { UploadDestination, UploadedFile } from '../FileUpload';

export { buildPromptWithAttachments } from '@agor-live/client';

export const COMPOSER_PREVIEW_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const COMPOSER_UPLOAD_EXTENSION_MIME_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
]);

export const MAX_COMPOSER_UPLOAD_FILES = 10;
export const MAX_COMPOSER_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_COMPOSER_UPLOAD_TOTAL_SIZE = 100 * 1024 * 1024;
export const MAX_COMPOSER_UPLOAD_FILES_MESSAGE = `Composer supports up to ${MAX_COMPOSER_UPLOAD_FILES} attachments`;

export type ComposerAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
  destination: UploadDestination;
  status: ComposerAttachmentStatus;
  uploadedFile?: UploadedFile;
  error?: string;
}

export interface ComposerFileRejection {
  file: File;
  reason: string;
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

function inferComposerUploadMimeType(file: File): string {
  const normalizedMime = normalizeMimeType(file.type || '');
  if (normalizedMime) return normalizedMime;

  const normalizedName = file.name.toLowerCase();
  const matchingExtension = Array.from(COMPOSER_UPLOAD_EXTENSION_MIME_TYPES.keys())
    .sort((a, b) => b.length - a.length)
    .find((extension) => normalizedName.endsWith(extension));

  return matchingExtension
    ? (COMPOSER_UPLOAD_EXTENSION_MIME_TYPES.get(matchingExtension) ?? '')
    : '';
}

function normalizeComposerUploadFile(file: File): File {
  const inferredMime = inferComposerUploadMimeType(file);
  const normalizedMime = normalizeMimeType(file.type || '');

  if (!inferredMime || normalizedMime) return file;

  // Browser drag/drop and clipboard APIs can leave File.type empty even for
  // common safe extensions. Give FormData the inferred allowlisted MIME so the
  // upload endpoint sees the same type the composer validated.
  return new File([file], file.name, { type: inferredMime, lastModified: file.lastModified });
}

export function isPreviewableComposerImage(file: File): boolean {
  return COMPOSER_PREVIEW_IMAGE_MIME_TYPES.has(inferComposerUploadMimeType(file));
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function validateComposerFileIntake(
  files: File[],
  currentAttachments: ComposerAttachment[] = [],
  destination: UploadDestination = 'branch'
): { acceptedFiles: File[]; rejections: ComposerFileRejection[] } {
  const rejections: ComposerFileRejection[] = [];
  const currentUploadBatch = currentAttachments.filter(
    (attachment) => attachment.destination === destination
  );
  let totalSize = currentUploadBatch.reduce((sum, attachment) => sum + attachment.file.size, 0);
  const candidates: File[] = [];

  for (const file of files) {
    if (file.size > MAX_COMPOSER_UPLOAD_FILE_SIZE) {
      rejections.push({
        file,
        reason: `File is larger than ${formatBytes(MAX_COMPOSER_UPLOAD_FILE_SIZE)}`,
      });
      continue;
    }

    candidates.push(normalizeComposerUploadFile(file));
  }

  if (currentUploadBatch.length + candidates.length > MAX_COMPOSER_UPLOAD_FILES) {
    rejections.push(
      ...candidates.map((file) => ({
        file,
        reason: MAX_COMPOSER_UPLOAD_FILES_MESSAGE,
      }))
    );
    return { acceptedFiles: [], rejections };
  }

  const acceptedFiles: File[] = [];
  for (const file of candidates) {
    if (totalSize + file.size > MAX_COMPOSER_UPLOAD_TOTAL_SIZE) {
      rejections.push({
        file,
        reason: `Selected files exceed ${formatBytes(MAX_COMPOSER_UPLOAD_TOTAL_SIZE)} total`,
      });
      continue;
    }

    acceptedFiles.push(file);
    totalSize += file.size;
  }

  return { acceptedFiles, rejections };
}

export function summarizeComposerFileRejections(rejections: ComposerFileRejection[]): string {
  if (rejections.length === 0) return '';

  const first =
    rejections.find((rejection) => rejection.reason === MAX_COMPOSER_UPLOAD_FILES_MESSAGE) ??
    rejections[0];
  const suffix = rejections.length > 1 ? ` (+${rejections.length - 1} more)` : '';
  return `${first.file.name}: ${first.reason}${suffix}`;
}

export function isBlockingComposerAttachment(attachment: ComposerAttachment): boolean {
  return attachment.status === 'failed';
}

export function getComposerUploadAccept(): undefined {
  return undefined;
}
