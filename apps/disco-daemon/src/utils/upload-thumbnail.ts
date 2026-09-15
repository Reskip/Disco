import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

/** Rasterize the first frame only and strip metadata. The original is never modified. */
export async function createUploadThumbnail(source: NodeJS.ReadableStream): Promise<Buffer> {
  const transform = sharp({ animated: false })
    .rotate()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 });
  try {
    const result = transform.toBuffer();
    const [, buffer] = await Promise.all([pipeline(source, transform), result]);
    return buffer;
  } finally {
    (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    transform.destroy();
  }
}

/** Bounded derivative cache and conversion concurrency, independent of original file sizes. */
export class UploadThumbnailCache {
  private readonly cache = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly waiting: Array<() => void> = [];
  private bytes = 0;
  private active = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

  async get(key: string, read: () => Promise<NodeJS.ReadableStream>): Promise<Buffer> {
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const job = this.convert(read)
      .then((buffer) => {
        if (buffer.length <= this.maxBytes) {
          while (this.bytes + buffer.length > this.maxBytes) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.bytes -= this.cache.get(oldest)!.length;
            this.cache.delete(oldest);
          }
          this.cache.set(key, buffer);
          this.bytes += buffer.length;
        }
        return buffer;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async convert(read: () => Promise<NodeJS.ReadableStream>): Promise<Buffer> {
    if (this.active < 2) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await createUploadThumbnail(await read());
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
