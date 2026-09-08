import type { ImagePreviewType } from 'antd/es/image';
import { useEffect, useMemo, useState } from 'react';

export const DISCO_IMAGE_PREVIEW_CLASS = 'disco-image-preview';

export function isImagePreviewWheelTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(`.${DISCO_IMAGE_PREVIEW_CLASS}`));
}

/**
 * Ant Image consumes wheel input to zoom its preview, but browsers also treat
 * Ctrl+wheel/trackpad pinch as page zoom. Prevent only the browser default
 * while the preview is open; the event still reaches Ant Image so the image
 * itself keeps zooming normally.
 */
export function useIsolatedImagePreview(mask = '查看原图'): ImagePreviewType {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const preventPageZoom = (event: WheelEvent) => {
      if (isImagePreviewWheelTarget(event.target)) event.preventDefault();
    };
    document.addEventListener('wheel', preventPageZoom, { capture: true, passive: false });
    return () => document.removeEventListener('wheel', preventPageZoom, { capture: true });
  }, [open]);

  return useMemo(
    () => ({
      mask,
      open,
      onOpenChange: setOpen,
      rootClassName: DISCO_IMAGE_PREVIEW_CLASS,
    }),
    [mask, open]
  );
}
