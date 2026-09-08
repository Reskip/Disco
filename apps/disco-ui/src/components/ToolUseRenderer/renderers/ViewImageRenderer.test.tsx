import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../../../hooks/useAuthenticatedUpload';
import { ViewImageRenderer } from './ViewImageRenderer';

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

describe('ViewImageRenderer', () => {
  it('recovers an authenticated thumbnail from a historical staged-image path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Blob(['legacy image'], { type: 'image/png' }), { status: 200 })
      )
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:legacy-viewed-image'),
        revokeObjectURL: vi.fn(),
      })
    );

    render(
      <ViewImageRenderer
        toolUseId="legacy-view"
        input={{
          path: String.raw`E:\session\.disco\session-staging\session-1\upl_00000000-0000-4000-8000-000000000009\legacy.png`,
        }}
        result={{ content: '[completed]' }}
        compact
      />
    );

    expect(await screen.findByRole('img', { name: 'legacy.png' })).toHaveAttribute(
      'src',
      'blob:legacy-viewed-image'
    );
    expect(screen.queryByText(/session-staging|upl_00000000/u)).not.toBeInTheDocument();
  });

  it('replaces an inaccessible historical local path with a bounded placeholder', () => {
    render(
      <ViewImageRenderer
        toolUseId="legacy-missing"
        input={{ path: 'E:/session/tmp/preview.png' }}
        result={{ content: '[completed]' }}
        compact
      />
    );

    expect(screen.getByText('历史图片预览不可用')).toBeVisible();
    expect(screen.queryByText(/E:\/session|preview\.png/u)).not.toBeInTheDocument();
  });
});
