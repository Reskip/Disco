import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createUploadThumbnail, UploadThumbnailCache } from './upload-thumbnail.js';

async function image(width = 2048, height = 1024) {
  return sharp({ create: { width, height, channels: 3, background: '#bca370' } })
    .png()
    .toBuffer();
}

describe('upload thumbnails', () => {
  it('produces a small WebP with the original aspect ratio, without changing the source', async () => {
    const original = await image();
    const before = Buffer.from(original);
    const thumb = await createUploadThumbnail(Readable.from(original));
    expect(await sharp(thumb).metadata()).toMatchObject({
      width: 640,
      height: 320,
      format: 'webp',
    });
    expect(thumb.length).toBeLessThan(original.length);
    expect(original.equals(before)).toBe(true);
  });

  it('does not enlarge small images and rejects non-images instead of returning their bytes', async () => {
    const thumb = await createUploadThumbnail(Readable.from(await image(32, 64)));
    expect(await sharp(thumb).metadata()).toMatchObject({ width: 32, height: 64 });
    await expect(
      createUploadThumbnail(Readable.from('private file, not an image'))
    ).rejects.toThrow();
  });

  it('honors photo orientation while stripping EXIF from the preview', async () => {
    const photo = await sharp(await image())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const thumb = await createUploadThumbnail(Readable.from(photo));
    const metadata = await sharp(thumb).metadata();
    expect(metadata).toMatchObject({ width: 320, height: 640 });
    expect(metadata.exif).toBeUndefined();
  });

  it('shares concurrent conversion, isolates cache keys and retries a failed read', async () => {
    const cache = new UploadThumbnailCache();
    const bytes = await image();
    const read = vi.fn(async () => Readable.from(bytes));
    const [first, second] = await Promise.all([
      cache.get('owner-a:ref', read),
      cache.get('owner-a:ref', read),
    ]);
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get('owner-a:ref', read);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get('owner-b:ref', read);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(
      cache.get('broken', async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');
    await cache.get('broken', read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('evicts derivatives when the cache budget is exhausted', async () => {
    const bytes = await image();
    const thumb = await createUploadThumbnail(Readable.from(bytes));
    const cache = new UploadThumbnailCache(thumb.length);
    const read = vi.fn(async () => Readable.from(bytes));
    await cache.get('one', read);
    await cache.get('two', read);
    await cache.get('one', read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('propagates source stream errors', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('read failed'));
      },
    });
    await expect(createUploadThumbnail(source)).rejects.toThrow('read failed');
  });
});
