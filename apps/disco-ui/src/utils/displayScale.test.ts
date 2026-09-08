import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStoredDisplayScale,
  DISPLAY_SCALE_OPTIONS,
  getStoredDisplayScale,
  saveDisplayScale,
} from './displayScale';

describe('local display scale', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.zoom = '';
    document.documentElement.style.overflow = '';
    document.documentElement.style.removeProperty('--disco-display-scale');
    document.documentElement.style.removeProperty('--disco-chat-effective-width');
    document.documentElement.style.removeProperty('--disco-effective-vw');
    document.documentElement.style.removeProperty('--disco-effective-vh');
    document.body.style.zoom = '';
    document.body.style.width = '';
    document.body.style.height = '';
    document.body.style.overflow = '';
    document.getElementById('root')?.remove();
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    vi.stubGlobal('crypto', { randomUUID: () => 'browser-a' });
  });

  it('is isolated by user on the current browser and applies immediately', () => {
    expect(getStoredDisplayScale('user-a')).toBe(1);
    expect(saveDisplayScale('user-a', 1.25)).toBe(1.25);
    expect(document.documentElement.style.zoom).toBe('');
    expect(document.documentElement.style.getPropertyValue('--disco-display-scale')).toBe('1.25');
    expect(document.documentElement.style.getPropertyValue('--disco-chat-effective-width')).toBe(
      'calc(748px / 1.25)'
    );
    expect(document.documentElement.style.getPropertyValue('--disco-effective-vw')).toBe(
      'calc(100vw / 1.25)'
    );
    expect(document.documentElement.style.getPropertyValue('--disco-effective-vh')).toBe(
      'calc(var(--disco-visible-viewport-height, 100dvh) / 1.25)'
    );
    expect(document.body.style.zoom).toBe('');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.width).toBe('100vw');
    expect(document.body.style.height).toBe('100vh');
    expect(document.body.style.overflow).toBe('hidden');
    const root = document.getElementById('root');
    expect(root?.style.zoom).toBe('1.25');
    // CSSOM simplifies calc(100vw / 1.25) to calc(80vw).
    expect(root?.style.width).toBe('calc(80vw)');
    expect(root?.style.height).toBe('calc(var(--disco-visible-viewport-height, 100dvh) / 1.25)');
    expect(root?.style.top).toBe('calc(var(--disco-visible-viewport-top, 0px) / 1.25)');
    expect(root?.style.overflow).toBe('hidden');
    expect(getStoredDisplayScale('user-b')).toBe(1);
    expect(applyStoredDisplayScale('user-a')).toBe(1.25);
  });

  it('falls back to 100% for an unsupported stored value', () => {
    localStorage.setItem('disco:local-device-id', 'browser-a');
    localStorage.setItem('disco:display-scale:browser-a:user-a', '3');
    expect(applyStoredDisplayScale('user-a')).toBe(1);
  });

  it('keeps the chat column at a fixed physical width at every scale', () => {
    for (const scale of DISPLAY_SCALE_OPTIONS) {
      expect(saveDisplayScale('user-a', scale)).toBe(scale);

      expect(
        document.documentElement.style.getPropertyValue('--disco-chat-effective-width')
      ).toBe(`calc(748px / ${scale})`);

      const root = document.getElementById('root');
      expect(root?.style.zoom).toBe(String(scale));
      expect(root?.style.overflow).toBe('hidden');
      expect(document.documentElement.style.overflow).toBe('hidden');
      expect(document.body.style.overflow).toBe('hidden');
    }
  });
});
