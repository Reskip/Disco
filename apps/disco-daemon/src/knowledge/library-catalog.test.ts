import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeLibrary } from './library';

describe('knowledge catalog concurrent reads', () => {
  it('keeps the owner lock until all metadata reads settle after a corrupt entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'disco-kb-catalog-unit-'));
    const owner = { tenantId: 'catalog-test', userId: 'reader' };
    const library = new KnowledgeLibrary(root);
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((done) => {
      releaseReads = done;
    });
    let concurrentReadStarted!: () => void;
    const readStarted = new Promise<void>((done) => {
      concurrentReadStarted = done;
    });
    try {
      for (let number = 0; number < 3; number++)
        await library.upsertSource(owner, {
          source: 'manual',
          sourceId: `entry-${number}`,
          kind: 'note',
          title: `笔记 ${number}`,
          markdown: `# 笔记 ${number}`,
        });
      const access = library as unknown as {
        read(base: string, file: string): Promise<Buffer | null>;
        exclusive<T>(
          owner: { tenantId: string; userId: string },
          task: () => Promise<T>
        ): Promise<T>;
      };
      const read = access.read.bind(library);
      let failed = false;
      vi.spyOn(access, 'read').mockImplementation(async (base, file) => {
        if (file.startsWith('.library/entries/')) {
          if (!failed) {
            failed = true;
            throw new Error('synthetic corrupt metadata');
          }
          concurrentReadStarted();
          await readsReleased;
        }
        return read(base, file);
      });
      const catalog = library.catalog(owner);
      const rejected = expect(catalog).rejects.toThrow('synthetic corrupt metadata');
      await readStarted;
      let nextEntered = false;
      const next = access.exclusive(owner, async () => {
        nextEntered = true;
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(nextEntered).toBe(false);
      releaseReads();
      await rejected;
      await next;
      expect(nextEntered).toBe(true);
      expect((await library.status(owner)).total).toBe(3);
    } finally {
      releaseReads();
      vi.restoreAllMocks();
      // This test owns exactly the newly-created temporary directory.
      if (
        dirname(resolve(root)) === resolve(tmpdir()) &&
        basename(root).startsWith('disco-kb-catalog-unit-')
      )
        await rm(root, { recursive: true, force: true });
    }
  });
});
