import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRemoved } from '../../store/discoRealtimeActions';
import { clearTokens, storeTokens } from '../../utils/tokenRefresh';
import { type UploadFilesToSessionOptions, uploadFilesToSession } from '../FileUpload/upload';
import { clearComposerAttachmentDrafts } from './composerAttachmentStore';
import { useComposerAttachments } from './useComposerAttachments';

vi.mock('../FileUpload/upload', () => ({ uploadFilesToSession: vi.fn() }));

function deferredUpload() {
  let resolve!: (value: Awaited<ReturnType<typeof uploadFilesToSession>>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof uploadFilesToSession>>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(filename = 'a.png') {
  return {
    success: true,
    files: [
      {
        ref: `upl-${filename}`,
        filename,
        size: 3,
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
    ],
  };
}

function token(userId: string, tenantId = 'tenant-a') {
  return `header.${btoa(JSON.stringify({ sub: userId, tenant_id: tenantId }))}.signature`;
}

function renderDraft(sessionId = 'session-a') {
  return renderHook(
    ({ id }) =>
      useComposerAttachments({
        sessionId: id,
        showError: vi.fn(),
      }),
    { initialProps: { id: sessionId } }
  );
}

describe('composer upload navigation', () => {
  beforeEach(() => {
    clearComposerAttachmentDrafts();
    localStorage.clear();
    storeTokens(token('user-a'));
    vi.mocked(uploadFilesToSession).mockReset();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:attachment'),
        revokeObjectURL: vi.fn(),
      })
    );
  });
  afterEach(() => {
    act(() => clearComposerAttachmentDrafts());
    vi.unstubAllGlobals();
  });

  it('keeps progress and completed files with their original conversation while another uploads', async () => {
    const a = deferredUpload();
    const b = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result, rerender } = renderDraft();
    act(() => result.current.addAttachments([new File(['aaa'], 'a.png', { type: 'image/png' })]));
    const aOptions = vi.mocked(uploadFilesToSession).mock.calls[0][0];
    rerender({ id: 'session-b' });
    expect(result.current.attachments).toEqual([]);
    act(() => result.current.addAttachments([new File(['bbb'], 'b.txt')]));
    act(() => aOptions.onProgress?.({ loaded: 2, total: 3, percent: 67 }));
    expect(result.current.attachments[0].file.name).toBe('b.txt');
    rerender({ id: 'session-a' });
    expect(result.current.uploadProgress).toBe(67);
    expect(aOptions.signal?.aborted).toBe(false);
    rerender({ id: 'session-b' });
    await act(async () => a.resolve(response()));
    expect(result.current.uploading).toBe(true);
    rerender({ id: 'session-a' });
    expect(result.current.attachments[0].uploadedFile?.filename).toBe('a.png');
    expect(result.current.uploading).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(uploadFilesToSession).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve(response('b.txt')));
  });

  it('continues the queued fourth file after unmount and restores all files on remount', async () => {
    const pending = Array.from({ length: 4 }, deferredUpload);
    pending.forEach((item) => {
      vi.mocked(uploadFilesToSession).mockReturnValueOnce(item.promise);
    });
    const { result, unmount } = renderDraft();
    act(() =>
      result.current.addAttachments(
        Array.from({ length: 4 }, (_, i) => new File(['x'], `${i}.txt`))
      )
    );
    expect(uploadFilesToSession).toHaveBeenCalledTimes(3);
    unmount();
    expect(
      vi.mocked(uploadFilesToSession).mock.calls.every(([options]) => !options.signal?.aborted)
    ).toBe(true);
    await act(async () => pending[0].resolve(response('0.txt')));
    expect(uploadFilesToSession).toHaveBeenCalledTimes(4);
    await act(async () =>
      pending.slice(1).forEach((item, i) => {
        item.resolve(response(`${i + 1}.txt`));
      })
    );
    const restored = renderDraft();
    expect(restored.result.current.attachments.map((a) => a.status)).toEqual(
      Array(4).fill('uploaded')
    );
    expect(uploadFilesToSession).toHaveBeenCalledTimes(4);
  });

  it('retains an upload failure while away and allows removing the failed file', async () => {
    const upload = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValue(upload.promise);
    const { result, rerender } = renderDraft();
    act(() => result.current.addAttachments([new File(['x'], 'bad.txt')]));
    rerender({ id: 'session-b' });
    await act(async () => upload.reject(new Error('上传连接中断，请重试。')));
    expect(result.current.hasAttachments).toBe(false);
    rerender({ id: 'session-a' });
    expect(result.current.attachments[0].error).toBe('上传连接中断，请重试。');
    expect(result.current.hasBlockingAttachments).toBe(true);
    act(() => result.current.removeAttachment(result.current.attachments[0].id));
    expect(result.current.hasAttachments).toBe(false);
  });

  it('keeps uploads across token refresh but cancels active and queued uploads on logout', async () => {
    const upload = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValue(upload.promise);
    const { result } = renderDraft();
    act(() =>
      result.current.addAttachments(
        Array.from({ length: 4 }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }))
      )
    );
    const waiting = result.current.uploadAttachments().catch((error: Error) => error.message);
    act(() => storeTokens(token('user-a')));
    expect(
      vi.mocked(uploadFilesToSession).mock.calls.every(([options]) => !options.signal?.aborted)
    ).toBe(true);
    act(() => clearTokens());
    expect(
      vi.mocked(uploadFilesToSession).mock.calls.every(([options]) => options.signal?.aborted)
    ).toBe(true);
    expect(await waiting).toBe('会话或登录状态已结束。');
    await act(async () => upload.resolve(response()));
    expect(uploadFilesToSession).toHaveBeenCalledTimes(3);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
    act(() => storeTokens(token('user-a')));
    expect(renderDraft().result.current.attachments).toEqual([]);
  });

  it('isolates the same session key between accounts and cancels the old account', async () => {
    const upload = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValue(upload.promise);
    const first = renderDraft();
    act(() => first.result.current.addAttachments([new File(['x'], 'private.txt')]));
    act(() => storeTokens(token('user-b')));
    expect(vi.mocked(uploadFilesToSession).mock.calls[0][0].signal?.aborted).toBe(true);
    const second = renderDraft();
    expect(second.result.current.attachments).toEqual([]);
    await act(async () => upload.resolve(response('private.txt')));
    expect(second.result.current.attachments).toEqual([]);
  });

  it('cancels and forgets only the removed conversation', async () => {
    const upload = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValue(upload.promise);
    const first = renderDraft();
    const second = renderDraft('session-b');
    act(() => {
      first.result.current.addAttachments([new File(['a'], 'a.txt')]);
      second.result.current.addAttachments([new File(['b'], 'b.txt')]);
    });
    act(() => sessionRemoved({ session_id: 'session-a' } as Parameters<typeof sessionRemoved>[0]));
    const calls = vi.mocked(uploadFilesToSession).mock.calls;
    expect(calls[0][0].signal?.aborted).toBe(true);
    expect(calls[1][0].signal?.aborted).toBe(false);
    expect(first.result.current.attachments).toEqual([]);
    await act(async () => upload.resolve(response()));
    await waitFor(() => expect(second.result.current.uploading).toBe(false));
  });

  it('does not share drafts between tenants with identical user and session ids', async () => {
    const upload = deferredUpload();
    vi.mocked(uploadFilesToSession).mockReturnValue(upload.promise);
    const first = renderDraft();
    act(() => first.result.current.addAttachments([new File(['x'], 'tenant-a.txt')]));
    act(() => storeTokens(token('user-a', 'tenant-b')));
    expect(vi.mocked(uploadFilesToSession).mock.calls[0][0].signal?.aborted).toBe(true);
    const second = renderDraft();
    expect(second.result.current.attachments).toEqual([]);
    await act(async () => upload.resolve(response('tenant-a.txt')));
    expect(second.result.current.attachments).toEqual([]);
  });

  it('clears only the submitted snapshot and keeps later attachments and send locks per session', async () => {
    vi.mocked(uploadFilesToSession).mockImplementation(
      async (options: UploadFilesToSessionOptions) => response(options.files[0].name)
    );
    const { result, rerender } = renderDraft();
    await act(async () => result.current.addAttachments([new File(['a'], 'a.txt')]));
    const submitted = result.current.attachments;
    const clearSubmitted = result.current.clearAttachments;
    const originalLock = result.current.sendingRef;
    originalLock.current = true;
    await act(async () => result.current.addAttachments([new File(['b'], 'later.txt')]));
    rerender({ id: 'session-b' });
    expect(result.current.sendingRef.current).toBe(false);
    act(() => clearSubmitted(submitted.map((a) => a.id)));
    rerender({ id: 'session-a' });
    expect(result.current.attachments.map((a) => a.file.name)).toEqual(['later.txt']);
    expect(result.current.sendingRef.current).toBe(true);
  });
});
