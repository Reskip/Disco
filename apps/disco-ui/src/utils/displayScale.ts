const DEVICE_ID_KEY = 'disco:local-device-id';
const DISPLAY_SCALE_PREFIX = 'disco:display-scale';

export const DISPLAY_SCALE_OPTIONS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export type DisplayScale = (typeof DISPLAY_SCALE_OPTIONS)[number];

function getLocalDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (existing) return existing;
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

function storageKey(userId: string): string {
  return `${DISPLAY_SCALE_PREFIX}:${getLocalDeviceId()}:${userId}`;
}

function normalizeScale(value: unknown): DisplayScale {
  const numeric = typeof value === 'number' ? value : Number(value);
  return DISPLAY_SCALE_OPTIONS.includes(numeric as DisplayScale) ? (numeric as DisplayScale) : 1;
}

export function getStoredDisplayScale(userId: string | null | undefined): DisplayScale {
  if (!userId) return 1;
  return normalizeScale(localStorage.getItem(storageKey(userId)));
}

export function applyDisplayScale(scale: DisplayScale): void {
  document.documentElement.style.setProperty('--disco-display-scale', String(scale));
  // Display scaling should enlarge type and controls without making the
  // reading column physically wider. The app root is zoomed below, so keep
  // the logical chat width reciprocal to that zoom: logical width × scale
  // remains 748 physical pixels whenever the viewport has enough room.
  document.documentElement.style.setProperty(
    '--disco-chat-effective-width',
    `calc(748px / ${scale})`
  );
  document.documentElement.style.setProperty('--disco-effective-vw', `calc(100vw / ${scale})`);
  document.documentElement.style.setProperty(
    '--disco-effective-vh',
    `calc(var(--disco-visible-viewport-height, 100dvh) / ${scale})`
  );
  // Scale the application viewport rather than <body>. The reciprocal root
  // dimensions make the UI reflow at the effective viewport size (like OS
  // display scaling), while the browser document remains exactly 100vw x
  // 100vh. Zooming <body> itself can leak its logical size into document
  // overflow and produce browser-level horizontal/vertical scrollbars.
  document.documentElement.style.removeProperty('zoom');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.removeProperty('zoom');
  document.body.style.width = '100vw';
  document.body.style.height = '100vh';
  document.body.style.overflow = 'hidden';

  const root = document.getElementById('root');
  if (root) {
    root.style.position = 'fixed';
    root.style.top = `calc(var(--disco-visible-viewport-top, 0px) / ${scale})`;
    root.style.left = '0';
    root.style.zoom = String(scale);
    root.style.width = `calc(100vw / ${scale})`;
    root.style.height = `calc(var(--disco-visible-viewport-height, 100dvh) / ${scale})`;
    root.style.overflow = 'hidden';
  }
}

export function applyStoredDisplayScale(userId: string | null | undefined): DisplayScale {
  const scale = getStoredDisplayScale(userId);
  applyDisplayScale(scale);
  return scale;
}

export function saveDisplayScale(userId: string, value: number): DisplayScale {
  const scale = normalizeScale(value);
  localStorage.setItem(storageKey(userId), String(scale));
  applyDisplayScale(scale);
  window.dispatchEvent(new CustomEvent('disco:display-scale-changed', { detail: { scale } }));
  return scale;
}
