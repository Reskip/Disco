import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../../hooks/useAuthenticatedUpload';
import { MessageAttachments } from './MessageAttachments';

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

describe('MessageAttachments rendering', () => {
  it('shares only the thumbnail request across message remounts', async () => {
    let finishFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_url: string) =>
        new Promise<Response>((resolve) => {
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/thumbnail$/);
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
    expect(screen.getByRole('button', { name: '播放 说明.mp3' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '播放 演示.mp4' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '下载 answer.py' })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: '下载 answer.py' }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '播放 说明.mp3' }));
    await waitFor(() => expect(screen.getByLabelText('播放 说明.mp3')).toHaveAttribute('controls'));
    expect(screen.getByLabelText('播放 说明.mp3')).toHaveAttribute('preload', 'none');
    fireEvent.click(screen.getByRole('button', { name: '播放 演示.mp4' }));
    await waitFor(() => expect(screen.getByLabelText('播放 演示.mp4')).toHaveAttribute('controls'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: '下载 报告.pdf' }));
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    clicked.mockRestore();
  });
});
