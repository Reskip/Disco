import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../../hooks/useAuthenticatedUpload';
import { MessageAttachments } from './MessageAttachments';

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

describe('MessageAttachments rendering', () => {
  it('shares an in-flight image request across message remounts', async () => {
    let finishFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          finishFetch = resolve;
        })
    );
    const createObjectURL = vi.fn(() => 'blob:shared-upload');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL,
        revokeObjectURL: vi.fn(),
      })
    );

    const attachment = {
      uploadRef: 'upl_00000000-0000-4000-8000-000000000003',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeLabel: '1.2 MiB',
    };
    const first = render(<MessageAttachments attachments={[attachment]} />);
    first.unmount();
    render(<MessageAttachments attachments={[attachment]} />);

    expect(fetchMock).toHaveBeenCalledOnce();
    finishFetch(new Response(new Blob(['image bytes'], { type: 'image/jpeg' }), { status: 200 }));

    expect(await screen.findByRole('img', { name: 'photo.jpg' })).toHaveAttribute(
      'src',
      'blob:shared-upload'
    );
    expect(screen.getByRole('button', { name: '下载 photo.jpg' })).toBeEnabled();
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  });

  it('renders published PDF, audio, video, and ordinary files with native actions', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['bytes'], { type: 'application/octet-stream' }), { status: 200 })
    );
    let objectUrlIndex = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:published-${++objectUrlIndex}`),
        revokeObjectURL: vi.fn(),
      })
    );

    render(
      <MessageAttachments
        attachments={[
          {
            uploadRef: 'upl_pdf',
            filename: '报告.pdf',
            mimeType: 'application/pdf',
            sizeLabel: '2 MiB',
          },
          {
            uploadRef: 'upl_audio',
            filename: '说明.mp3',
            mimeType: 'audio/mpeg',
            sizeLabel: '3 MiB',
          },
          {
            uploadRef: 'upl_video',
            filename: '演示.mp4',
            mimeType: 'video/mp4',
            sizeLabel: '8 MiB',
          },
          {
            uploadRef: 'upl_code',
            filename: 'answer.py',
            mimeType: 'text/x-python',
            sizeLabel: '1 KiB',
          },
        ]}
      />
    );

    expect(await screen.findByRole('button', { name: '打开 报告.pdf' })).toBeVisible();
    expect(screen.getByLabelText('播放 说明.mp3')).toHaveAttribute('controls');
    expect(screen.getByLabelText('播放 演示.mp4')).toHaveAttribute('controls');
    expect(screen.getByRole('button', { name: '下载 answer.py' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
