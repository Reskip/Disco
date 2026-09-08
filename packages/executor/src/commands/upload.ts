import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sanitizeUploadFilename } from '@disco/core/types';

function materializationRelativePath(params: {
  sessionId: string;
  uploadRef: string;
  filename: string;
}): string {
  return `.disco/session-staging/${params.sessionId}/${params.uploadRef}/${sanitizeUploadFilename(params.filename)}`;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

export async function materializeUploadToWorkspace(input: {
  daemonUrl: string;
  sessionToken: string;
  workspacePath: string;
  params: { sessionId: string; uploadRef: string; filename: string };
}): Promise<{ path: string; absolutePath: string }> {
  const workspaceRoot = await realpath(input.workspacePath);
  const relativePath = materializationRelativePath(input.params);
  const destination = resolve(workspaceRoot, relativePath);
  if (!isInside(workspaceRoot, destination)) throw new Error('Upload destination escapes workspace');

  await mkdir(dirname(destination), { recursive: true });
  const canonicalParent = await realpath(dirname(destination));
  if (!isInside(workspaceRoot, canonicalParent)) {
    throw new Error('Upload destination escapes workspace through a symlink');
  }

  const response = await fetch(
    `${input.daemonUrl}/executor/uploads/${input.params.uploadRef}/content`,
    { headers: { Authorization: `Bearer ${input.sessionToken}` } }
  );
  if (!response.ok || !response.body) {
    throw new Error(`Upload transfer failed with HTTP ${response.status}`);
  }

  await rm(destination, { force: true });
  const handle = await open(destination, 'wx');
  try {
    await pipeline(Readable.fromWeb(response.body as never), handle.createWriteStream());
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  return {
    path: relativePath.split(sep).join('/'),
    absolutePath: destination,
  };
}
