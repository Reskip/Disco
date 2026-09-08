import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DISCO_IMAGE_PREVIEW_CLASS,
  isImagePreviewWheelTarget,
  useIsolatedImagePreview,
} from './useIsolatedImagePreview';

function Harness() {
  const preview = useIsolatedImagePreview();
  return (
    <>
      <button type="button" onClick={() => preview.onOpenChange?.(true, false)}>
        打开
      </button>
      <div className={DISCO_IMAGE_PREVIEW_CLASS}>
        <img alt="预览图" />
      </div>
      <div data-testid="outside" />
    </>
  );
}

describe('isolated image preview zoom', () => {
  it('recognizes only wheel events originating inside the preview', () => {
    const view = render(<Harness />);
    expect(isImagePreviewWheelTarget(screen.getByRole('img', { name: '预览图' }))).toBe(true);
    expect(isImagePreviewWheelTarget(view.getByTestId('outside'))).toBe(false);
  });

  it('prevents browser page zoom while leaving the preview wheel event available', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
    const allowed = screen.getByRole('img', { name: '预览图' }).dispatchEvent(wheel);
    expect(allowed).toBe(false);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
