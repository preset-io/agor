import type { SessionID } from '@agor-live/client';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import type { UploadedFile } from '../FileUpload';
import { uploadFilesToSession } from '../FileUpload/upload';
import {
  type ComposerAttachment,
  isBlockingComposerAttachment,
  isPreviewableComposerImage,
  summarizeComposerFileRejections,
  validateComposerFileIntake,
} from './composerAttachments';

interface UseComposerAttachmentsOptions {
  sessionId: SessionID | null;
  showError: (message: string) => void;
  mutationLockedRef?: React.RefObject<boolean>;
}

export function useComposerAttachments({
  sessionId,
  showError,
  mutationLockedRef,
}: UseComposerAttachmentsOptions) {
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const previousSessionIdRef = React.useRef<SessionID | null>(sessionId);
  const attachmentsRef = React.useRef<ComposerAttachment[]>([]);
  const uploadingRef = React.useRef(false);

  attachmentsRef.current = attachments;
  uploadingRef.current = uploading;

  const revokePreview = React.useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  const clearAttachments = React.useCallback(() => {
    attachmentsRef.current.forEach(revokePreview);
    setAttachments([]);
  }, [revokePreview]);

  React.useEffect(
    () => () => {
      attachmentsRef.current.forEach(revokePreview);
    },
    [revokePreview]
  );

  React.useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    clearAttachments();
    setValidationError(null);
    previousSessionIdRef.current = sessionId;
  }, [sessionId, clearAttachments]);

  const addAttachments = React.useCallback(
    (files: File[]) => {
      if (uploadingRef.current || mutationLockedRef?.current) return;
      if (files.length === 0) return;

      const { acceptedFiles, rejections } = validateComposerFileIntake(
        files,
        attachmentsRef.current
      );
      if (rejections.length > 0) {
        const validationMessage = summarizeComposerFileRejections(rejections);
        setValidationError(validationMessage);
        showError(validationMessage);
      } else {
        setValidationError(null);
      }
      if (acceptedFiles.length === 0) return;

      setAttachments((prev) => [
        ...prev,
        ...acceptedFiles.map((file) => {
          const supported = isPreviewableComposerImage(file);
          return {
            id:
              typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${file.name}`,
            file,
            previewUrl: supported ? URL.createObjectURL(file) : undefined,
            destination: 'branch' as const,
            status: 'pending' as const,
          };
        }),
      ]);
    },
    [mutationLockedRef, showError]
  );

  const removeAttachment = React.useCallback(
    (id: string) => {
      if (uploadingRef.current || mutationLockedRef?.current) return;
      setValidationError(null);

      setAttachments((prev) => {
        const removed = prev.find((attachment) => attachment.id === id);
        if (removed) revokePreview(removed);
        return prev.filter((attachment) => attachment.id !== id);
      });
    },
    [mutationLockedRef, revokePreview]
  );

  const uploadAttachments = React.useCallback(
    async (
      attachmentsAtUploadStart: ComposerAttachment[] = attachmentsRef.current,
      uploadSessionId: SessionID | null = sessionId
    ): Promise<UploadedFile[]> => {
      if (!uploadSessionId) {
        throw new Error('Cannot upload attachments without an active session.');
      }

      const current = attachmentsAtUploadStart;
      if (current.length === 0) return [];

      const blockingAttachment = current.find(isBlockingComposerAttachment);
      if (blockingAttachment) {
        throw new Error(
          `${blockingAttachment.file.name} failed or cannot be uploaded. Remove failed files before sending.`
        );
      }

      const reusableUploaded = current.flatMap((attachment) =>
        attachment.uploadedFile ? [attachment.uploadedFile] : []
      );
      const uploadable = current.filter((attachment) => attachment.status !== 'uploaded');

      if (uploadable.length === 0) {
        return reusableUploaded;
      }

      setUploading(true);
      uploadingRef.current = true;
      setAttachments((prev) =>
        prev.map((attachment) =>
          uploadable.some((candidate) => candidate.id === attachment.id)
            ? { ...attachment, status: 'uploading', error: undefined }
            : attachment
        )
      );

      const uploadedById = new Map<string, UploadedFile>();

      try {
        const result = await uploadFilesToSession({
          sessionId: uploadSessionId,
          daemonUrl: getDaemonUrl(),
          files: uploadable.map((attachment) => attachment.file),
          notifyAgent: false,
        });

        if (result.files.length !== uploadable.length) {
          throw new Error('Upload response did not include every selected file');
        }

        uploadable.forEach((attachment, index) => {
          const uploaded = result.files[index];
          if (uploaded) uploadedById.set(attachment.id, uploaded);
        });

        setAttachments((prev) =>
          prev.map((attachment) => {
            const uploadedFile = uploadedById.get(attachment.id);
            return uploadedFile
              ? { ...attachment, status: 'uploaded', uploadedFile, error: undefined }
              : attachment;
          })
        );

        const uploadedFileById = new Map<string, UploadedFile>();
        current.forEach((attachment) => {
          if (attachment.uploadedFile) uploadedFileById.set(attachment.id, attachment.uploadedFile);
        });
        uploadedById.forEach((uploadedFile, attachmentId) => {
          uploadedFileById.set(attachmentId, uploadedFile);
        });

        return current.flatMap((attachment) => {
          const uploaded = uploadedFileById.get(attachment.id);
          return uploaded ? [uploaded] : [];
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to upload files';
        setAttachments((prev) =>
          prev.map((attachment) =>
            uploadable.some((candidate) => candidate.id === attachment.id)
              ? { ...attachment, status: 'failed', error: message }
              : attachment
          )
        );
        throw error;
      } finally {
        uploadingRef.current = false;
        setUploading(false);
      }
    },
    [sessionId]
  );

  return {
    attachments,
    attachmentsRef,
    clearAttachments,
    hasAttachments: attachments.length > 0,
    hasBlockingAttachments: attachments.some(isBlockingComposerAttachment),
    addAttachments,
    removeAttachment,
    uploadAttachments,
    uploading,
    uploadingRef,
    validationError,
    setValidationError,
  };
}
