import type { UploadDestination, UploadedFile } from '../FileUpload';

export const COMPOSER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

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

export function isSupportedComposerImage(file: File): boolean {
  return COMPOSER_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

export function isBlockingComposerImageAttachment(attachment: ComposerImageAttachment): boolean {
  return attachment.status === 'failed';
}

export function getComposerImageAccept(): string {
  return '';
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
