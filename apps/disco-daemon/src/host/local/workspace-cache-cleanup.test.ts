import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupWorkspaceCaches } from './workspace-cache-cleanup.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disco-retention-'));
  roots.push(root);
  const userRoot = join(root, 'user-one');
  const paths = [
    'standalone/one/__pycache__/render.cpython-312.pyc',
    'standalone/one/.disco/tmp/preview.png',
    'standalone/one/.disco/tmp/source.psd',
    'standalone/one/.disco/tmp/render.py',
    'standalone/one/.disco/tmp/unknown.bin',
    'standalone/one/preview.png',
    'standalone/one/source.psd',
    'standalone/one/.disco/session-staging/upl-ref/__pycache__/input.pyc',
  ];
  for (const file of paths) {
    const target = join(userRoot, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file);
  }
  return { root, userRoot, paths, now: new Date(Date.now() + 8 * 86400_000) };
}
describe('temporary workspace retention', () => {
  it('cleans only expired regenerable caches and declared temporary renders, preserving sources and uploads', async () => {
    const f = await fixture();
    const result = await cleanupWorkspaceCaches({
      ...f,
      retentionDays: 7,
      isIdle: async () => true,
    });
    expect(result).toMatchObject({ eligible: 2, deleted: 2, skippedActive: false });
    for (const file of f.paths.slice(0, 2))
      await expect(readFile(join(f.userRoot, file))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of f.paths.slice(2))
      expect(await readFile(join(f.userRoot, file), 'utf8')).toBe(file);
  });
  it('obeys a longer window, disabling cleanup, dry runs and an account becoming active', async () => {
    const f = await fixture();
    const isIdle = vi.fn(async () => true);
    expect(await cleanupWorkspaceCaches({ ...f, retentionDays: 30, isIdle })).toMatchObject({
      deleted: 0,
      eligible: 0,
    });
    expect(await cleanupWorkspaceCaches({ ...f, retentionDays: 0, isIdle })).toMatchObject({
      examined: 0,
    });
    expect(
      await cleanupWorkspaceCaches({ ...f, retentionDays: 7, isIdle, dryRun: true })
    ).toMatchObject({ deleted: 0, eligible: 2 });
    isIdle.mockResolvedValue(false);
    expect(await cleanupWorkspaceCaches({ ...f, retentionDays: 7, isIdle })).toMatchObject({
      deleted: 0,
      skippedActive: true,
    });
  });
  it('does not traverse directory links into another account', async () => {
    const f = await fixture();
    const other = join(f.root, 'user-other', '__pycache__');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'private.pyc'), 'private');
    await symlink(
      other,
      join(f.userRoot, 'linked-cache'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await cleanupWorkspaceCaches({ ...f, retentionDays: 7, isIdle: async () => true });
    expect(await readFile(join(other, 'private.pyc'), 'utf8')).toBe('private');
  });
  it('fails closed when account activity cannot be checked and bounds each scan', async () => {
    const f = await fixture();
    await expect(
      cleanupWorkspaceCaches({
        ...f,
        retentionDays: 7,
        isIdle: async () => {
          throw new Error('database offline');
        },
      })
    ).rejects.toThrow('database offline');
    expect(
      await cleanupWorkspaceCaches({
        ...f,
        retentionDays: 7,
        isIdle: async () => true,
        maxEntries: 1,
      })
    ).toMatchObject({ truncated: true, deleted: 0 });
  });
});
