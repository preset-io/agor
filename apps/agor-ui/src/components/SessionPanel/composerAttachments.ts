import {
  buildUploadAttachmentPrompt,
  formatUploadBytes,
  type UploadIngressPolicy,
} from '@agor/core/types';
import type { UploadedFile } from '../FileUpload';

export const COMPOSER_PREVIEW_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const COMPOSER_UPLOAD_MIME_TYPES = new Set([
  ...COMPOSER_PREVIEW_IMAGE_MIME_TYPES,
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/gzip',
  'application/x-tar',
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
export const MAX_COMPOSER_UPLOAD_FILES_MESSAGE = `Composer supports up to ${MAX_COMPOSER_UPLOAD_FILES} pending files`;

export type ComposerAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
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

export function isSupportedComposerUploadFile(file: File): boolean {
  return COMPOSER_UPLOAD_MIME_TYPES.has(inferComposerUploadMimeType(file));
}

export function validateComposerFileIntake(
  files: File[],
  currentAttachments: ComposerAttachment[] = [],
  policy: UploadIngressPolicy = {
    maxFileBytes: MAX_COMPOSER_UPLOAD_FILE_SIZE,
    maxTotalBytes: MAX_COMPOSER_UPLOAD_TOTAL_SIZE,
    maxFiles: MAX_COMPOSER_UPLOAD_FILES,
  }
): { acceptedFiles: File[]; rejections: ComposerFileRejection[] } {
  const rejections: ComposerFileRejection[] = [];
  const currentUploadBatch = currentAttachments.filter(
    (attachment) => attachment.status !== 'uploaded'
  );
  let totalSize = currentUploadBatch.reduce((sum, attachment) => sum + attachment.file.size, 0);
  const candidates: File[] = [];

  for (const file of files) {
    if (!isSupportedComposerUploadFile(file)) {
      rejections.push({
        file,
        reason: `Unsupported file type: ${file.type || 'unknown'}`,
      });
      continue;
    }

    if (file.size > policy.maxFileBytes) {
      rejections.push({
        file,
        reason: `File is larger than ${formatUploadBytes(policy.maxFileBytes)}`,
      });
      continue;
    }

    candidates.push(normalizeComposerUploadFile(file));
  }

  if (currentUploadBatch.length + candidates.length > policy.maxFiles) {
    const filesMessage = `Composer supports up to ${policy.maxFiles} pending files`;
    rejections.push(
      ...candidates.map((file) => ({
        file,
        reason: filesMessage,
      }))
    );
    return { acceptedFiles: [], rejections };
  }

  const acceptedFiles: File[] = [];
  for (const file of candidates) {
    if (totalSize + file.size > policy.maxTotalBytes) {
      rejections.push({
        file,
        reason: `Selected files exceed ${formatUploadBytes(policy.maxTotalBytes)} total`,
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
    rejections.find((rejection) => rejection.reason.startsWith('Composer supports up to ')) ??
    rejections[0];
  const suffix = rejections.length > 1 ? ` (+${rejections.length - 1} more)` : '';
  return `${first.file.name}: ${first.reason}${suffix}`;
}

export function isBlockingComposerAttachment(attachment: ComposerAttachment): boolean {
  return attachment.status === 'failed';
}

export function getComposerAttachmentFailureMessage(attachment: ComposerAttachment): string {
  return `${attachment.file.name}: ${attachment.error?.trim() || 'Upload failed'}`;
}

export function getComposerUploadAccept(): string {
  return Array.from(COMPOSER_UPLOAD_MIME_TYPES).join(',');
}

export interface ComposerPromptValueSource {
  promptHandle?: { getValue: () => string } | null;
  inputValueRefValue?: string;
  sendStartValue: string;
}

export function getLatestComposerPromptText({
  promptHandle,
  inputValueRefValue,
  sendStartValue,
}: ComposerPromptValueSource): string {
  return promptHandle?.getValue() ?? inputValueRefValue ?? sendStartValue;
}

export interface PromptAttachment {
  ref: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function buildPromptWithAttachments(text: string, attachments: PromptAttachment[]): string {
  return buildUploadAttachmentPrompt(text, attachments);
}
