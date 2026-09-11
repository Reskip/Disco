import type { UploadIngressPolicy } from '@disco/core/types';
import type { SessionID } from '@disco-live/client';
import { createStore } from 'zustand/vanilla';
import { getDaemonUrl } from '../../config/daemon';
import { getCurrentTenantIdFromJwt, getCurrentUserIdFromJwt } from '../../utils/authHeaders';
import { TOKENS_CHANGED_EVENT } from '../../utils/tokenRefresh';
import { type UploadedFile, uploadFilesToSession } from '../FileUpload/upload';
import {
  type ComposerAttachment,
  isBlockingComposerAttachment,
  isPreviewableComposerImage,
  summarizeComposerFileRejections,
  validateComposerFileIntake,
} from './composerAttachments';

type UploadOutcome = { ok: true; file: UploadedFile } | { ok: false; error: Error };

interface AttachmentState {
  attachments: ComposerAttachment[];
  validationError: string | null;
}

// The signed-in account owns requests, outcomes and previews. Conversation
// views only subscribe to their selected draft, so navigation cannot abort it.
class ComposerAttachmentDraft {
  readonly store = createStore<AttachmentState>(() => ({
    attachments: [],
    validationError: null,
  }));
  readonly sendingRef = { current: false };
  private disposed = false;
  private controllers = new Map<string, AbortController>();
  private outcomes = new Map<string, Promise<UploadOutcome>>();
  private resolvers = new Map<string, (outcome: UploadOutcome) => void>();
  readonly sessionId: SessionID | null;
  readonly userId: string | null;
  readonly daemonUrl: string;
  readonly tenantId: string | null;

  constructor(
    sessionId: SessionID | null,
    userId: string | null,
    daemonUrl: string,
    tenantId: string | null
  ) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.daemonUrl = daemonUrl;
    this.tenantId = tenantId;
  }

  get uploading(): boolean {
    return this.store
      .getState()
      .attachments.some(
        (attachment) => attachment.status === 'pending' || attachment.status === 'uploading'
      );
  }

  private contains(id: string): boolean {
    return !this.disposed && this.store.getState().attachments.some((a) => a.id === id);
  }

  private update(id: string, patch: Partial<ComposerAttachment>): void {
    if (!this.contains(id)) return;
    this.store.setState((state) => ({
      attachments: state.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  }

  private settle(id: string, outcome: UploadOutcome): void {
    this.resolvers.get(id)?.(outcome);
    this.resolvers.delete(id);
  }

  setValidationError = (validationError: string | null): void => {
    if (!this.disposed) this.store.setState({ validationError });
  };

  clear = (ids?: string[]): void => {
    const selected = ids ? new Set(ids) : null;
    const { attachments } = this.store.getState();
    const removed = attachments.filter((a) => !selected || selected.has(a.id));
    this.store.setState({
      attachments: attachments.filter((a) => selected && !selected.has(a.id)),
      validationError: null,
    });
    for (const attachment of removed) {
      this.settle(attachment.id, { ok: false, error: new Error('附件上传已取消。') });
      this.controllers.get(attachment.id)?.abort();
      this.controllers.delete(attachment.id);
      this.outcomes.delete(attachment.id);
      if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
    }
  };

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  remove = (id: string): void => {
    if (!this.uploading) this.clear([id]);
  };

  add(files: File[], policy?: UploadIngressPolicy): string | null {
    if (this.disposed || this.uploading || files.length === 0) return null;
    const { acceptedFiles, rejections } = validateComposerFileIntake(
      files,
      this.store.getState().attachments,
      policy
    );
    const validationError = rejections.length ? summarizeComposerFileRejections(rejections) : null;
    this.setValidationError(validationError);
    const batch: ComposerAttachment[] = acceptedFiles.map((file) => ({
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${file.name}`,
      file,
      previewUrl: isPreviewableComposerImage(file) ? URL.createObjectURL(file) : undefined,
      status: 'pending',
      progress: 0,
    }));
    for (const attachment of batch) {
      this.outcomes.set(
        attachment.id,
        new Promise<UploadOutcome>((resolve) => this.resolvers.set(attachment.id, resolve))
      );
    }
    this.store.setState((state) => ({ attachments: [...state.attachments, ...batch] }));
    void this.uploadBatch(batch);
    return validationError;
  }

  private async uploadBatch(batch: ComposerAttachment[]): Promise<void> {
    const queue = [...batch];
    const worker = async () => {
      while (queue.length > 0 && !this.disposed) {
        const attachment = queue.shift();
        if (!attachment || !this.contains(attachment.id)) continue;
        const controller = new AbortController();
        this.controllers.set(attachment.id, controller);
        this.update(attachment.id, { status: 'uploading', progress: 0 });
        try {
          if (!this.sessionId) throw new Error('没有可用会话，无法上传附件。');
          const result = await uploadFilesToSession({
            sessionId: this.sessionId,
            daemonUrl: this.daemonUrl,
            files: [attachment.file],
            notifyAgent: false,
            signal: controller.signal,
            onProgress: ({ percent }) => this.update(attachment.id, { progress: percent }),
          });
          if (!this.contains(attachment.id)) continue;
          const uploadedFile = result.files[0];
          if (!uploadedFile) throw new Error('上传结果缺少文件引用');
          this.update(attachment.id, { status: 'uploaded', progress: 100, uploadedFile });
          this.settle(attachment.id, { ok: true, file: uploadedFile });
        } catch (error) {
          if (!this.contains(attachment.id)) continue;
          const failure = error instanceof Error ? error : new Error('文件上传失败');
          this.update(attachment.id, { status: 'failed', error: failure.message });
          this.settle(attachment.id, { ok: false, error: failure });
        } finally {
          this.controllers.delete(attachment.id);
        }
      }
    };
    // Preserve the three-file pool, including queued files after navigation.
    await Promise.all(Array.from({ length: Math.min(3, batch.length) }, worker));
  }

  waitForUploads = async (
    attachments = this.store.getState().attachments,
    sessionId = this.sessionId
  ): Promise<UploadedFile[]> => {
    if (this.disposed) throw new Error('会话或登录状态已结束。');
    if (!sessionId || sessionId !== this.sessionId) {
      throw new Error('没有可用会话，无法上传附件。');
    }
    const blocking = attachments.find(isBlockingComposerAttachment);
    if (blocking) throw new Error(`${blocking.file.name} 上传失败。请移除失败文件后再发送。`);
    const outcomes = await Promise.all(
      attachments.map((attachment): UploadOutcome | Promise<UploadOutcome> => {
        if (attachment.uploadedFile) return { ok: true, file: attachment.uploadedFile };
        return (
          this.outcomes.get(attachment.id) ?? {
            ok: false,
            error: new Error(`${attachment.file.name} 缺少上传任务。`),
          }
        );
      })
    );
    if (this.disposed) throw new Error('会话或登录状态已结束。');
    const failure = outcomes.find((outcome) => !outcome.ok);
    if (failure && !failure.ok) throw failure.error;
    return outcomes.flatMap((outcome) => (outcome.ok ? [outcome.file] : []));
  };
}

const drafts = new Map<string, ComposerAttachmentDraft>();

export function getComposerAttachmentDraft(sessionId: SessionID | null, userId?: string | null) {
  const owner = userId ?? getCurrentUserIdFromJwt();
  const daemonUrl = getDaemonUrl();
  const tenantId = getCurrentTenantIdFromJwt();
  const key = JSON.stringify([daemonUrl, tenantId, owner, sessionId]);
  let draft = drafts.get(key);
  if (!draft) {
    draft = new ComposerAttachmentDraft(sessionId, owner, daemonUrl, tenantId);
    drafts.set(key, draft);
  }
  return draft;
}

export function clearComposerAttachmentDrafts(sessionId?: string): void {
  for (const [key, draft] of drafts) {
    if (sessionId !== undefined && draft.sessionId !== sessionId) continue;
    draft.dispose();
    drafts.delete(key);
  }
}

function clearOtherAccounts(): void {
  const userId = getCurrentUserIdFromJwt();
  const tenantId = getCurrentTenantIdFromJwt();
  const daemonUrl = getDaemonUrl();
  for (const [key, draft] of drafts) {
    if (
      userId !== null &&
      draft.userId === userId &&
      draft.tenantId === tenantId &&
      draft.daemonUrl === daemonUrl
    )
      continue;
    draft.dispose();
    drafts.delete(key);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(TOKENS_CHANGED_EVENT, clearOtherAccounts);
  window.addEventListener('storage', clearOtherAccounts);
}
