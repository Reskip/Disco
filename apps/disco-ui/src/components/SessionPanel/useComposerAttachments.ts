import type { UploadIngressPolicy } from '@disco/core/types';
import type { SessionID } from '@disco-live/client';
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
  uploadPolicy?: UploadIngressPolicy;
}

type UploadOutcome =
  | { ok: true; file: UploadedFile }
  | { ok: false; error: Error };

export function useComposerAttachments({
  sessionId,
  showError,
  uploadPolicy,
}: UseComposerAttachmentsOptions) {
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const previousSessionIdRef = React.useRef<SessionID | null>(sessionId);
  const attachmentsRef = React.useRef<ComposerAttachment[]>([]);
  const uploadingRef = React.useRef(false);
  const uploadGenerationRef = React.useRef(0);
  const pendingUploadCountRef = React.useRef(0);
  const activeUploadControllersRef = React.useRef(new Map<string, AbortController>());
  const uploadOutcomePromisesRef = React.useRef(new Map<string, Promise<UploadOutcome>>());
  const uploadOutcomeResolversRef = React.useRef(
    new Map<string, (outcome: UploadOutcome) => void>()
  );

  attachmentsRef.current = attachments;
  uploadingRef.current = uploading;

  const revokePreview = React.useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  const forgetAttachmentOutcome = React.useCallback((id: string) => {
    uploadOutcomePromisesRef.current.delete(id);
    uploadOutcomeResolversRef.current.delete(id);
  }, []);

  const settleAttachmentOutcome = React.useCallback((id: string, outcome: UploadOutcome) => {
    uploadOutcomeResolversRef.current.get(id)?.(outcome);
    uploadOutcomeResolversRef.current.delete(id);
  }, []);

  const cancelPendingOutcomes = React.useCallback((message: string) => {
    for (const [id, resolve] of uploadOutcomeResolversRef.current) {
      resolve({ ok: false, error: new Error(message) });
      uploadOutcomeResolversRef.current.delete(id);
    }
  }, []);

  const clearAttachments = React.useCallback(() => {
    attachmentsRef.current.forEach((attachment) => {
      revokePreview(attachment);
      forgetAttachmentOutcome(attachment.id);
    });
    setAttachments([]);
  }, [forgetAttachmentOutcome, revokePreview]);

  React.useEffect(
    () => () => {
      activeUploadControllersRef.current.forEach((controller) => {
        controller.abort();
      });
      activeUploadControllersRef.current.clear();
      cancelPendingOutcomes('附件上传已取消。');
      uploadOutcomePromisesRef.current.clear();
      attachmentsRef.current.forEach(revokePreview);
    },
    [cancelPendingOutcomes, revokePreview]
  );

  React.useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    uploadGenerationRef.current += 1;
    activeUploadControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    activeUploadControllersRef.current.clear();
    cancelPendingOutcomes('已切换会话，附件上传已取消。');
    uploadOutcomePromisesRef.current.clear();
    pendingUploadCountRef.current = 0;
    uploadingRef.current = false;
    setUploading(false);
    clearAttachments();
    setValidationError(null);
    previousSessionIdRef.current = sessionId;
  }, [sessionId, cancelPendingOutcomes, clearAttachments]);

  const uploadAttachmentBatch = React.useCallback(
    async (
      batch: ComposerAttachment[],
      uploadSessionId: SessionID,
      generation: number
    ): Promise<void> => {
      const queue = [...batch];
      const worker = async () => {
        while (queue.length > 0) {
          const attachment = queue.shift();
          if (!attachment) return;
          const controller = new AbortController();
          activeUploadControllersRef.current.set(attachment.id, controller);
          if (uploadGenerationRef.current === generation) {
            setAttachments((prev) =>
              prev.map((candidate) =>
                candidate.id === attachment.id
                  ? { ...candidate, status: 'uploading', progress: 0, error: undefined }
                  : candidate
              )
            );
          }

          try {
            const result = await uploadFilesToSession({
              sessionId: uploadSessionId,
              daemonUrl: getDaemonUrl(),
              files: [attachment.file],
              notifyAgent: false,
              signal: controller.signal,
              onProgress: ({ percent }) => {
                if (uploadGenerationRef.current !== generation) return;
                setAttachments((prev) =>
                  prev.map((candidate) =>
                    candidate.id === attachment.id && candidate.status === 'uploading'
                      ? { ...candidate, progress: percent }
                      : candidate
                  )
                );
              },
            });
            const uploadedFile = result.files[0];
            if (!uploadedFile) throw new Error('上传结果缺少文件引用');
            if (uploadGenerationRef.current === generation) {
              setAttachments((prev) =>
                prev.map((candidate) =>
                  candidate.id === attachment.id
                    ? {
                        ...candidate,
                        status: 'uploaded',
                        progress: 100,
                        uploadedFile,
                        error: undefined,
                      }
                    : candidate
                )
              );
              settleAttachmentOutcome(attachment.id, { ok: true, file: uploadedFile });
            }
          } catch (error) {
            if (uploadGenerationRef.current === generation) {
              const message = error instanceof Error ? error.message : '文件上传失败';
              setAttachments((prev) =>
                prev.map((candidate) =>
                  candidate.id === attachment.id
                    ? { ...candidate, status: 'failed', error: message }
                  : candidate
                )
              );
              settleAttachmentOutcome(attachment.id, {
                ok: false,
                error: error instanceof Error ? error : new Error(message),
              });
            }
          } finally {
            activeUploadControllersRef.current.delete(attachment.id);
            if (uploadGenerationRef.current === generation) {
              pendingUploadCountRef.current = Math.max(0, pendingUploadCountRef.current - 1);
              if (pendingUploadCountRef.current === 0) {
                uploadingRef.current = false;
                setUploading(false);
              }
            }
          }
        }
      };

      // A small pool gives every file its own measurable progress while avoiding
      // ten simultaneous multipart bodies across a remote reverse proxy.
      await Promise.all(Array.from({ length: Math.min(3, batch.length) }, () => worker()));
    },
    [settleAttachmentOutcome]
  );

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

      const newAttachments = acceptedFiles.map((file) => {
        const supported = isPreviewableComposerImage(file);
        return {
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${file.name}`,
          file,
          previewUrl: supported ? URL.createObjectURL(file) : undefined,
          status: 'pending' as const,
          progress: 0,
        };
      });
      for (const attachment of newAttachments) {
        const outcomePromise = new Promise<UploadOutcome>((resolve) => {
          uploadOutcomeResolversRef.current.set(attachment.id, resolve);
        });
        uploadOutcomePromisesRef.current.set(attachment.id, outcomePromise);
      }
      setAttachments((prev) => [...prev, ...newAttachments]);

      if (!sessionId) {
        setAttachments((prev) =>
          prev.map((attachment) =>
            newAttachments.some((candidate) => candidate.id === attachment.id)
              ? { ...attachment, status: 'failed', error: '没有可用会话，无法上传附件。' }
              : attachment
          )
        );
        for (const attachment of newAttachments) {
          settleAttachmentOutcome(attachment.id, {
            ok: false,
            error: new Error('没有可用会话，无法上传附件。'),
          });
        }
        return;
      }

      const generation = uploadGenerationRef.current;
      pendingUploadCountRef.current += newAttachments.length;
      uploadingRef.current = true;
      setUploading(true);
      void uploadAttachmentBatch(newAttachments, sessionId, generation);
    },
    [sessionId, settleAttachmentOutcome, showError, uploadAttachmentBatch, uploadPolicy]
  );

  const removeAttachment = React.useCallback(
    (id: string) => {
      if (uploadingRef.current) return;
      setValidationError(null);

      setAttachments((prev) => {
        const removed = prev.find((attachment) => attachment.id === id);
        if (removed) {
          revokePreview(removed);
          forgetAttachmentOutcome(removed.id);
        }
        return prev.filter((attachment) => attachment.id !== id);
      });
    },
    [forgetAttachmentOutcome, revokePreview]
  );

  const uploadAttachments = React.useCallback(
    async (
      attachmentsAtUploadStart: ComposerAttachment[] = attachmentsRef.current,
      uploadSessionId: SessionID | null = sessionId
    ): Promise<UploadedFile[]> => {
      if (!uploadSessionId) {
        throw new Error('没有可用会话，无法上传附件。');
      }

      const current = attachmentsAtUploadStart;
      if (current.length === 0) return [];

      const blockingAttachment = current.find(isBlockingComposerAttachment);
      if (blockingAttachment) {
        throw new Error(`${blockingAttachment.file.name} 上传失败。请移除失败文件后再发送。`);
      }

      const outcomes = await Promise.all(
        current.map(async (attachment): Promise<UploadOutcome> => {
          if (attachment.uploadedFile) return { ok: true, file: attachment.uploadedFile };
          const outcomePromise = uploadOutcomePromisesRef.current.get(attachment.id);
          if (!outcomePromise) {
            return { ok: false, error: new Error(`${attachment.file.name} 缺少上传任务。`) };
          }
          return outcomePromise;
        })
      );
      const failure = outcomes.find((outcome) => !outcome.ok);
      if (failure && !failure.ok) throw failure.error;
      return outcomes.flatMap((outcome) => (outcome.ok ? [outcome.file] : []));
    },
    [sessionId]
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
    clearAttachments,
    hasAttachments: attachments.length > 0,
    hasBlockingAttachments: attachments.some(isBlockingComposerAttachment),
    addAttachments,
    removeAttachment,
    uploadAttachments,
    uploading,
    uploadProgress,
    uploadingRef,
    validationError,
    setValidationError,
  };
}
