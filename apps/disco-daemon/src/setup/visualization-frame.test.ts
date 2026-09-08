import { describe, expect, it, vi } from 'vitest';
import {
  serveVisualizationFrame,
  VISUALIZATION_FRAME_CSP,
  VISUALIZATION_FRAME_HTML,
} from './visualization-frame';

describe('visualization frame', () => {
  it('uses the official static-resource allowlist without allowing API calls', () => {
    expect(VISUALIZATION_FRAME_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(VISUALIZATION_FRAME_CSP).toContain('https://cdn.jsdelivr.net');
    expect(VISUALIZATION_FRAME_CSP).toContain('https://esm.sh');
    expect(VISUALIZATION_FRAME_CSP).toContain('connect-src blob: data:');
    expect(VISUALIZATION_FRAME_CSP).not.toContain('connect-src https:');
  });

  it('accepts one bounded document from its parent and never embeds attachment data itself', () => {
    expect(VISUALIZATION_FRAME_HTML).toContain('event.source !== parent');
    expect(VISUALIZATION_FRAME_HTML).toContain("payload.type !== 'disco:visualization-document'");
    expect(VISUALIZATION_FRAME_HTML).toContain('payload.html.length > 10 * 1024 * 1024');
    expect(VISUALIZATION_FRAME_HTML).not.toContain('Authorization');
    expect(VISUALIZATION_FRAME_HTML).not.toContain('/uploads/');
  });

  it('overrides the app CSP and removes DENY only for the empty frame route', () => {
    const headers = new Map<string, string>();
    const response = {
      setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
      removeHeader: vi.fn((name: string) => headers.delete(name)),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    serveVisualizationFrame({} as never, response as never, vi.fn());

    expect(headers.get('Content-Security-Policy')).toBe(VISUALIZATION_FRAME_CSP);
    expect(response.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
    expect(response.type).toHaveBeenCalledWith('html');
    expect(response.send).toHaveBeenCalledWith(VISUALIZATION_FRAME_HTML);
  });
});
