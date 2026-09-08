import { afterEach, describe, expect, it } from 'vitest';
import { installVisualViewportSizing } from './visualViewport';

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');

afterEach(() => {
  document.documentElement.style.removeProperty('--disco-visible-viewport-height');
  document.documentElement.style.removeProperty('--disco-visible-viewport-top');
  if (originalVisualViewport) {
    Object.defineProperty(window, 'visualViewport', originalVisualViewport);
  } else {
    Reflect.deleteProperty(window, 'visualViewport');
  }
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
});

describe('installVisualViewportSizing', () => {
  it('falls back to the layout viewport when VisualViewport is unavailable', () => {
    Reflect.deleteProperty(window, 'visualViewport');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 812 });

    const dispose = installVisualViewportSizing();

    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-height')).toBe(
      '812px'
    );
    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-top')).toBe(
      '0px'
    );
    dispose();
  });

  it('tracks visual viewport resize and pan caused by browser chrome or a keyboard', () => {
    const events = new EventTarget();
    const viewport = events as VisualViewport & { height: number; offsetTop: number };
    viewport.height = 500;
    viewport.offsetTop = 44;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });

    const dispose = installVisualViewportSizing();
    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-height')).toBe(
      '500px'
    );
    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-top')).toBe(
      '44px'
    );

    viewport.height = 436;
    viewport.offsetTop = 18;
    events.dispatchEvent(new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-height')).toBe(
      '436px'
    );
    expect(document.documentElement.style.getPropertyValue('--disco-visible-viewport-top')).toBe(
      '18px'
    );
    dispose();
  });
});
