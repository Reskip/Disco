import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeUploadToWorkspace } from './upload.js';

let workspace = '';

afterEach(async () => {
  vi.restoreAllMocks();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = '';
});

describe('upload materialization', () => {
  it('preserves a Chinese filename in the session staging path', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'disco-upload-materialize-'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('payload'));

    const result = await materializeUploadToWorkspace({
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'session-token',
      workspacePath: workspace,
      params: {
        sessionId: '01a04e12-20de-7a48-a092-4716b1017217',
        uploadRef: 'upl_00000000-0000-4000-8000-000000000001',
        filename: '外壳.SLDPRT',
      },
    });

    expect(result.path).toBe(
      '.disco/session-staging/01a04e12-20de-7a48-a092-4716b1017217/upl_00000000-0000-4000-8000-000000000001/外壳.SLDPRT'
    );
    expect(await readFile(result.absolutePath, 'utf8')).toBe('payload');
  });
});
