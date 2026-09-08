import { describe, expect, it } from 'vitest';
import { getRouterBasename, uiRouteHref } from './uiRoutes';

describe('uiRoutes', () => {
  it('uses the /ui basename when the UI is mounted under /ui', () => {
    expect(getRouterBasename('/ui/', '/ui/')).toBe('/ui');
    expect(uiRouteHref('/a/artifact/fullscreen', '/ui/', '/ui/')).toBe(
      '/ui/a/artifact/fullscreen'
    );
  });

  it('uses root routes when a bundled /ui build is reverse-proxied at the origin root', () => {
    expect(getRouterBasename('/ui/', '/')).toBe('');
    expect(uiRouteHref('/a/artifact/fullscreen', '/ui/', '/')).toBe('/a/artifact/fullscreen');
  });

  it('omits the basename for dev-root mounted UI routes', () => {
    expect(getRouterBasename('/')).toBe('');
    expect(uiRouteHref('a/artifact/fullscreen', '/')).toBe('/a/artifact/fullscreen');
  });

  it('accepts canonical /ui deep links in root-mounted dev environments', () => {
    expect(getRouterBasename('/', '/ui/s/session-id')).toBe('/ui');
    expect(getRouterBasename('/', '/')).toBe('');
  });
});
