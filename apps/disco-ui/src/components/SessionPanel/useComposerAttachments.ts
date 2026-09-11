import type { UploadIngressPolicy } from '@disco/core/types';
import type { SessionID } from '@disco-live/client';
import React from 'react';
import { useStore } from 'zustand';
import { getComposerAttachmentDraft } from './composerAttachmentStore';
import { isBlockingComposerAttachment } from './composerAttachments';

interface UseComposerAttachmentsOptions {
  sessionId: SessionID | null;
  userId?: string;
  showError: (message: string) => void;
  uploadPolicy?: UploadIngressPolicy;
}

export function useComposerAttachments({
  sessionId,
  userId,
  showError,
  uploadPolicy,
}: UseComposerAttachmentsOptions) {
  const draft = getComposerAttachmentDraft(sessionId, userId);
  const { attachments, validationError } = useStore(draft.store);
  const uploading = draft.uploading;
  // A resumed send must read its own draft even after the view has switched.
  const attachmentsRef = React.useMemo(
    () => ({
      get current() {
        return draft.store.getState().attachments;
      },
    }),
    [draft]
  );
  const uploadingRef = React.useMemo(
    () => ({
      get current() {
        return draft.uploading;
      },
    }),
    [draft]
  );
  const addAttachments = React.useCallback(
    (files: File[]) => {
      const error = draft.add(files, uploadPolicy);
      if (error) showError(error);
    },
    [draft, showError, uploadPolicy]
  );
  const uploadProgress = React.useMemo(() => {
    if (!uploading || attachments.length === 0) return null;
    const total = attachments.reduce((sum, attachment) => {
      if (attachment.status === 'uploaded') return sum + 100;
      if (attachment.status === 'uploading') return sum + (attachment.progress ?? 0);
      return sum;
    }, 0);
    return Math.max(0, Math.min(100, Math.round(total / attachments.length)));
  }, [attachments, uploading]);

  return {
    attachments,
    attachmentsRef,
    clearAttachments: draft.clear,
    hasAttachments: attachments.length > 0,
    hasBlockingAttachments: attachments.some(isBlockingComposerAttachment),
    addAttachments,
    removeAttachment: draft.remove,
    uploadAttachments: draft.waitForUploads,
    uploading,
    uploadProgress,
    uploadingRef,
    sendingRef: draft.sendingRef,
    validationError,
    setValidationError: draft.setValidationError,
  };
}
