import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Response } from 'express';

const ONE_YEAR_SECONDS = 31_536_000;
const HASHED_ASSET_RE = /[-.][a-zA-Z0-9_-]{8,}\./;
const PRECOMPRESSED_SUFFIX_RE = /\.(?:gz|br)$/i;

function stripPrecompressedSuffix(filePath: string): string {
  return filePath.replace(PRECOMPRESSED_SUFFIX_RE, '');
}

function isHashedAsset(filePath: string): boolean {
  const logicalPath = stripPrecompressedSuffix(filePath);
  const normalized = logicalPath.split(path.sep).join('/');
  const basename = path.basename(logicalPath);
  return normalized.includes('/assets/') && HASHED_ASSET_RE.test(basename);
}

export function setBundledUiStaticHeaders(res: ServerResponse, filePath: string): void {
  if (isHashedAsset(filePath)) {
    res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    return;
  }

  if (path.basename(stripPrecompressedSuffix(filePath)) === 'index.html') {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

export function setBundledUiFallbackHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-cache');
}

const ROOT_MOUNTED_UI_PREFIXES = new Set([
  'a',
  'b',
  'demo',
  'm',
  'marketplace',
  's',
  'settings',
  'w',
]);

/**
 * Whether a root-mounted GET should receive the SPA shell.
 *
 * The installed UI is also available under /ui, but public reverse proxies
 * commonly expose it at the origin root. Keep this allowlisted so API paths
 * such as /sessions, /tasks, /socket.io, and /health still reach Feathers.
 */
export function isBundledUiDeepLink(pathname: string): boolean {
  const normalized = pathname.replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const [prefix] = normalized.split('/');
  return ROOT_MOUNTED_UI_PREFIXES.has(prefix);
}
