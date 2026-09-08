import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ExecutorResult, WorkspaceFilesListPayload } from '../payload-types.js';
import type { CommandOptions } from './index.js';

interface FileResult {
  path: string;
  type: 'file' | 'folder';
}

const MAX_SCANNED_FILES = 50_000;
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

async function collectWorkspaceFiles(
  root: string,
  directory: string,
  files: string[]
): Promise<void> {
  if (files.length >= MAX_SCANNED_FILES) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (files.length >= MAX_SCANNED_FILES) return;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await collectWorkspaceFiles(root, fullPath, files);
    } else if (stats.isFile()) {
      files.push(relative(root, fullPath).split(sep).join('/'));
    }
  }
}

function buildFileResults(files: string[], search: string, limit: number): FileResult[] {
  if (!search.trim()) return [];
  const folders = new Set<string>();
  for (const filePath of files) {
    const parts = filePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(`${parts.slice(0, index).join('/')}/`);
    }
  }
  const query = search.toLowerCase();
  return [
    ...Array.from(folders)
      .filter((path) => path.toLowerCase().includes(query))
      .map((path) => ({ path, type: 'folder' as const })),
    ...files
      .filter((path) => path.toLowerCase().includes(query))
      .map((path) => ({ path, type: 'file' as const })),
  ].slice(0, limit);
}

export async function handleWorkspaceFilesList(
  payload: WorkspaceFilesListPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const workingDirectory = resolve(payload.params.workingDirectory);
  const search = payload.params.search;
  const limit = payload.params.limit ?? 10;

  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: payload.command, workingDirectory, search, limit },
    };
  }

  try {
    const stats = await lstat(workingDirectory);
    if (!stats.isDirectory()) return { success: true, data: { results: [] } };
    const files: string[] = [];
    await collectWorkspaceFiles(workingDirectory, workingDirectory, files);
    return {
      success: true,
      data: { workingDirectory, results: buildFileResults(files, search, limit) },
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { success: true, data: { results: [] } };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[workspace.files.list] Failed:', message);
    return {
      success: false,
      error: {
        code: 'WORKSPACE_FILES_LIST_FAILED',
        message,
        details: { workingDirectory },
      },
    };
  }
}
