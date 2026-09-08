const VISIBLE_VIEWPORT_HEIGHT = '--disco-visible-viewport-height';
const VISIBLE_VIEWPORT_TOP = '--disco-visible-viewport-top';

const formatPixels = (value: number) => `${Math.max(0, Math.round(value * 100) / 100)}px`;

/**
 * Keep the application shell aligned with the part of the page that is
 * actually visible. Mobile browser chrome and the on-screen keyboard can
 * resize or pan the visual viewport without changing 100vh/the layout
 * viewport, which otherwise pushes the session header or composer offscreen.
 */
export function installVisualViewportSizing(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const rootStyle = document.documentElement.style;
  const visualViewport = window.visualViewport;

  const update = () => {
    const height = visualViewport?.height ?? window.innerHeight;
    const offsetTop = visualViewport?.offsetTop ?? 0;
    rootStyle.setProperty(VISIBLE_VIEWPORT_HEIGHT, formatPixels(height));
    rootStyle.setProperty(VISIBLE_VIEWPORT_TOP, formatPixels(offsetTop));
  };

  update();
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update, { passive: true });
  visualViewport?.addEventListener('resize', update, { passive: true });
  visualViewport?.addEventListener('scroll', update, { passive: true });

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
    rootStyle.removeProperty(VISIBLE_VIEWPORT_HEIGHT);
    rootStyle.removeProperty(VISIBLE_VIEWPORT_TOP);
  };
}
