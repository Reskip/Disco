import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { getCurrentUserIdFromJwt } from '../utils/authHeaders';

interface UploadCacheEntry {
  loaded?: LoadedUpload;
  promise?: Promise<LoadedUpload>;
  failedAt?: number;
}

interface LoadedUpload {
  objectUrl: string;
  blob: Blob;
  mimeType: string;
  size: number;
}

const uploadCache = new Map<string, UploadCacheEntry>();
const FAILURE_RETRY_MS = 15_000;

function cacheKey(uploadRef: string): string {
  return `${getCurrentUserIdFromJwt() ?? 'anonymous'}:${uploadRef}`;
}

function cachedUpload(uploadRef: string): LoadedUpload | null {
  return uploadCache.get(cacheKey(uploadRef))?.loaded ?? null;
}

async function loadUpload(uploadRef: string): Promise<LoadedUpload> {
  const key = cacheKey(uploadRef);
  const cached = uploadCache.get(key);
  if (cached?.loaded) return cached.loaded;
  if (cached?.promise) return cached.promise;
  if (cached?.failedAt && Date.now() - cached.failedAt < FAILURE_RETRY_MS) {
    throw new Error('Upload is temporarily unavailable');
  }

  const entry: UploadCacheEntry = cached ?? {};
  const promise = authenticatedFetch(
    `${getDaemonUrl().replace(/\/$/, '')}/uploads/${encodeURIComponent(uploadRef)}/content`,
    {
      // Keep the authenticated response in the browser cache as well as the
      // in-memory object URL. Session switches should not download the same
      // image again.
      cache: 'force-cache',
    },
    { daemonUrl: getDaemonUrl() }
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const loaded = {
        objectUrl: URL.createObjectURL(blob),
        blob,
        mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
        size: blob.size,
      };
      entry.loaded = loaded;
      entry.failedAt = undefined;
      return loaded;
    })
    .catch((error) => {
      entry.failedAt = Date.now();
      throw error;
    })
    .finally(() => {
      entry.promise = undefined;
    });

  entry.promise = promise;
  uploadCache.set(key, entry);
  return promise;
}

export function clearAuthenticatedUploadCache(): void {
  for (const entry of uploadCache.values()) {
    if (entry.loaded?.objectUrl) URL.revokeObjectURL(entry.loaded.objectUrl);
  }
  uploadCache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearAuthenticatedUploadCache);
}

/**
 * Load an authenticated Disco upload once per browser user and keep it alive
 * across message remounts and session switches. In-flight requests are shared
 * rather than aborted when streaming updates temporarily remount a message.
 */
export function useAuthenticatedUpload(uploadRef: string): {
  objectUrl: string | null;
  blob: Blob | null;
  mimeType: string | null;
  size: number | null;
  loading: boolean;
  unavailable: boolean;
} {
  const initial = uploadRef ? cachedUpload(uploadRef) : null;
  const [loaded, setLoaded] = useState<LoadedUpload | null>(initial);
  const [loading, setLoading] = useState(!initial);
  const [unavailable, setUnavailable] = useState(!uploadRef);

  useEffect(() => {
    let mounted = true;
    if (!uploadRef) {
      setLoaded(null);
      setLoading(false);
      setUnavailable(true);
      return () => {
        mounted = false;
      };
    }
    const cached = cachedUpload(uploadRef);
    if (cached) {
      setLoaded(cached);
      setLoading(false);
      setUnavailable(false);
      return () => {
        mounted = false;
      };
    }

    setLoaded(null);
    setLoading(true);
    setUnavailable(false);
    void loadUpload(uploadRef)
      .then((result) => {
        if (mounted) setLoaded(result);
      })
      .catch(() => {
        if (mounted) setUnavailable(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [uploadRef]);

  return {
    objectUrl: loaded?.objectUrl ?? null,
    blob: loaded?.blob ?? null,
    mimeType: loaded?.mimeType ?? null,
    size: loaded?.size ?? null,
    loading,
    unavailable,
  };
}
