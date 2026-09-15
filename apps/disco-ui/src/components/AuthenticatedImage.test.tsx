import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../hooks/useAuthenticatedUpload';
import { AuthenticatedImage } from './AuthenticatedImage';

let intersect: IntersectionObserverCallback;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      intersect = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  fetchMock = vi.fn(
    async (url: string) =>
      new Response(
        new Blob([url.endsWith('/thumbnail') ? 'small' : 'original'], { type: 'image/webp' }),
        { status: 200 }
      )
  );
  vi.stubGlobal('fetch', fetchMock);
  let count = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:image-${++count}`),
      revokeObjectURL: vi.fn(),
    })
  );
});

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

function reveal() {
  act(() =>
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  );
}

describe('authenticated image loading', () => {
  it('waits until visible for the thumbnail and until a preview click for the original', async () => {
    render(<AuthenticatedImage uploadRef="upl_photo" filename="照片.png" />);
    expect(fetchMock).not.toHaveBeenCalled();
    reveal();
    expect(await screen.findByRole('img', { name: '照片.png' })).toHaveAttribute(
      'src',
      'blob:image-1'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/thumbnail$/);
    fireEvent.click(screen.getByRole('img', { name: '照片.png' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/content$/);
    await waitFor(() => expect(document.querySelector('img[src="blob:image-2"]')).not.toBeNull());
  });

  it('never falls back to original bytes automatically when a thumbnail is unsupported', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/thumbnail')
        ? new Response('', { status: 415 })
        : new Response(new Blob(['original']), { status: 200 })
    );
    render(<AuthenticatedImage uploadRef="upl_svg" filename="矢量图.svg" />);
    reveal();
    expect(await screen.findByText('预览图不可用，点击查看原图')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '查看原图 矢量图.svg' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/content$/);
  });

  it('opens the original through keyboard operation', async () => {
    render(<AuthenticatedImage uploadRef="upl_keyboard" filename="键盘.png" />);
    reveal();
    const image = await screen.findByRole('img', { name: '键盘.png' });
    fireEvent.keyDown(image, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/content$/);
  });
});
