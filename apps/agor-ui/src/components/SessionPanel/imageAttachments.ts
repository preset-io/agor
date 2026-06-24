import type { UploadDestination, UploadedFile } from '../FileUpload';

export const COMPOSER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const COMPOSER_UPLOAD_MIME_TYPES = new Set([
  ...COMPOSER_IMAGE_MIME_TYPES,
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

export const MAX_COMPOSER_UPLOAD_FILES = 10;
export const MAX_COMPOSER_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_COMPOSER_UPLOAD_TOTAL_SIZE = 100 * 1024 * 1024;

export type ComposerImageAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface ComposerImageAttachment {
  id: string;
  file: File;
  previewUrl?: string;
  destination: UploadDestination;
  status: ComposerImageAttachmentStatus;
  uploadedFile?: UploadedFile;
  error?: string;
}

export interface ComposerFileRejection {
  file: File;
  reason: string;
}

export function isSupportedComposerImage(file: File): boolean {
  return COMPOSER_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

export function isSupportedComposerUploadFile(file: File): boolean {
  return COMPOSER_UPLOAD_MIME_TYPES.has((file.type || '').split(';')[0].trim().toLowerCase());
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function validateComposerFileIntake(
  files: File[],
  currentAttachments: ComposerImageAttachment[] = [],
  destination: UploadDestination = 'branch'
): { acceptedFiles: File[]; rejections: ComposerFileRejection[] } {
  const acceptedFiles: File[] = [];
  const rejections: ComposerFileRejection[] = [];
  const currentUploadBatch = currentAttachments.filter(
    (attachment) => attachment.destination === destination && attachment.status !== 'uploaded'
  );
  let totalSize = currentUploadBatch.reduce((sum, attachment) => sum + attachment.file.size, 0);
  let remainingSlots = Math.max(0, MAX_COMPOSER_UPLOAD_FILES - currentUploadBatch.length);

  for (const file of files) {
    if (!isSupportedComposerUploadFile(file)) {
      rejections.push({
        file,
        reason: `Unsupported file type: ${file.type || 'unknown'}`,
      });
      continue;
    }

    if (file.size > MAX_COMPOSER_UPLOAD_FILE_SIZE) {
      rejections.push({
        file,
        reason: `File is larger than ${formatBytes(MAX_COMPOSER_UPLOAD_FILE_SIZE)}`,
      });
      continue;
    }

    if (remainingSlots <= 0) {
      rejections.push({
        file,
        reason: `Composer supports up to ${MAX_COMPOSER_UPLOAD_FILES} pending files per destination`,
      });
      continue;
    }

    if (totalSize + file.size > MAX_COMPOSER_UPLOAD_TOTAL_SIZE) {
      rejections.push({
        file,
        reason: `Selected files exceed ${formatBytes(MAX_COMPOSER_UPLOAD_TOTAL_SIZE)} total`,
      });
      continue;
    }

    acceptedFiles.push(file);
    totalSize += file.size;
    remainingSlots -= 1;
  }

  return { acceptedFiles, rejections };
}

export function summarizeComposerFileRejections(rejections: ComposerFileRejection[]): string {
  if (rejections.length === 0) return '';

  const [first] = rejections;
  const suffix = rejections.length > 1 ? ` (+${rejections.length - 1} more)` : '';
  return `${first.file.name}: ${first.reason}${suffix}`;
}

export function isBlockingComposerImageAttachment(attachment: ComposerImageAttachment): boolean {
  return attachment.status === 'failed';
}

export function getComposerImageAccept(): string {
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

export function buildPromptWithImageAttachments(text: string, imagePaths: string[]): string {
  const trimmedText = text.trim();
  if (imagePaths.length === 0) return trimmedText;

  const attachmentBlock = ['Attached files:', ...imagePaths.map((path) => `- ${path}`)].join('\n');
  return trimmedText ? `${attachmentBlock}\n\n${trimmedText}` : attachmentBlock;
}
