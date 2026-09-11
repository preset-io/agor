import type { UploadIngressPolicy } from '@agor/core/types';
import type { SessionID } from '@agor-live/client';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import type { UploadedFile } from '../FileUpload';
import { uploadFilesToSession } from '../FileUpload/upload';
import {
  type ComposerAttachment,
  getComposerAttachmentFailureMessage,
  isBlockingComposerAttachment,
  isPreviewableComposerImage,
  summarizeComposerFileRejections,
  validateComposerFileIntake,
} from './composerAttachments';

interface UseComposerAttachmentsOptions {
  sessionId: SessionID | null;
  scopeKey: string;
  showError: (message: string) => void;
  uploadPolicy?: UploadIngressPolicy;
}

export function useComposerAttachments({
  sessionId,
  scopeKey,
  showError,
  uploadPolicy,
}: UseComposerAttachmentsOptions) {
  const [storedAttachments, setStoredAttachments] = React.useState<ComposerAttachment[]>([]);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const previousScopeKeyRef = React.useRef(scopeKey);
  const scopeKeyRef = React.useRef(scopeKey);
  const attachmentsRef = React.useRef<ComposerAttachment[]>([]);
  const storedAttachmentsRef = React.useRef<ComposerAttachment[]>([]);
  const uploadingRef = React.useRef(false);

  // Hide the previous caller's state synchronously; the effect below owns
  // cleanup/revocation once React has committed the new scope.
  const scopeMatches = previousScopeKeyRef.current === scopeKey;
  const attachments = scopeMatches ? storedAttachments : [];
  const visibleUploading = scopeMatches ? uploading : false;
  const visibleValidationError = scopeMatches ? validationError : null;
  attachmentsRef.current = attachments;
  storedAttachmentsRef.current = storedAttachments;
  uploadingRef.current = visibleUploading;
  scopeKeyRef.current = scopeKey;

  const revokePreview = React.useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  const clearAttachments = React.useCallback(() => {
    const previous = storedAttachmentsRef.current;
    attachmentsRef.current = [];
    storedAttachmentsRef.current = [];
    previous.forEach(revokePreview);
    setStoredAttachments([]);
  }, [revokePreview]);

  React.useEffect(
    () => () => {
      storedAttachmentsRef.current.forEach(revokePreview);
    },
    [revokePreview]
  );

  React.useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return;
    clearAttachments();
    setValidationError(null);
    uploadingRef.current = false;
    setUploading(false);
    previousScopeKeyRef.current = scopeKey;
  }, [scopeKey, clearAttachments]);

  const addAttachments = React.useCallback(
    (files: File[]) => {
      if (uploadingRef.current) return;
      if (files.length === 0) return;

      const { acceptedFiles, rejections } = validateComposerFileIntake(
        files,
        attachmentsRef.current,
        uploadPolicy
      );
      if (rejections.length > 0) {
        const validationMessage = summarizeComposerFileRejections(rejections);
        setValidationError(validationMessage);
        showError(validationMessage);
      } else {
        setValidationError(null);
      }
      if (acceptedFiles.length === 0) return;

      setStoredAttachments([
        ...attachmentsRef.current,
        ...acceptedFiles.map((file) => {
          const supported = isPreviewableComposerImage(file);
          return {
            id:
              typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${file.name}`,
            file,
            previewUrl: supported ? URL.createObjectURL(file) : undefined,
            status: 'pending' as const,
          };
        }),
      ]);
    },
    [showError, uploadPolicy]
  );

  const removeAttachment = React.useCallback(
    (id: string) => {
      if (uploadingRef.current) return;
      setValidationError(null);

      setStoredAttachments((prev) => {
        const current = scopeKeyRef.current === scopeKey ? prev : [];
        const removed = current.find((attachment) => attachment.id === id);
        if (removed) revokePreview(removed);
        return current.filter((attachment) => attachment.id !== id);
      });
    },
    [revokePreview, scopeKey]
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
      const uploadScopeKey = scopeKeyRef.current;
      if (current.length === 0) return [];

      const blockingAttachment = current.find(isBlockingComposerAttachment);
      if (blockingAttachment) {
        throw new Error(
          `${getComposerAttachmentFailureMessage(blockingAttachment)}. Remove failed files before sending.`
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
      setStoredAttachments((prev) =>
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

        if (scopeKeyRef.current === uploadScopeKey) {
          setStoredAttachments((prev) =>
            prev.map((attachment) => {
              const uploadedFile = uploadedById.get(attachment.id);
              return uploadedFile
                ? { ...attachment, status: 'uploaded', uploadedFile, error: undefined }
                : attachment;
            })
          );
        }

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
        if (scopeKeyRef.current === uploadScopeKey) {
          setStoredAttachments((prev) =>
            prev.map((attachment) =>
              uploadable.some((candidate) => candidate.id === attachment.id)
                ? { ...attachment, status: 'failed', error: message }
                : attachment
            )
          );
        }
        throw error;
      } finally {
        if (scopeKeyRef.current === uploadScopeKey) {
          uploadingRef.current = false;
          setUploading(false);
        }
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
    uploading: visibleUploading,
    uploadingRef,
    validationError: visibleValidationError,
    setValidationError,
  };
}
