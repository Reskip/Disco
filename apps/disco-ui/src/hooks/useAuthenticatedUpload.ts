import { useCallback, useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { getCurrentUserIdFromJwt } from '../utils/authHeaders';

type UploadVariant = 'content' | 'thumbnail';

interface LoadedUpload {
  objectUrl: string;
  blob: Blob;
  mimeType: string;
  size: number;
}

interface UploadCacheEntry {
  loaded?: LoadedUpload;
  promise?: Promise<LoadedUpload>;
  controller?: AbortController;
  failedAt?: number;
}

const uploadCache = new Map<string, UploadCacheEntry>();
const FAILURE_RETRY_MS = 15_000;

function cacheKey(uploadRef: string, variant: UploadVariant): string {
  return `${getCurrentUserIdFromJwt() ?? 'anonymous'}:${uploadRef}:${variant}`;
}

async function loadUpload(
  uploadRef: string,
  variant: UploadVariant,
  retry: boolean
): Promise<LoadedUpload> {
  if (!uploadRef) throw new Error('Upload is unavailable');
  const key = cacheKey(uploadRef, variant);
  const cached = uploadCache.get(key);
  if (cached?.loaded) return cached.loaded;
  if (cached?.promise) return cached.promise;
  if (!retry && cached?.failedAt && Date.now() - cached.failedAt < FAILURE_RETRY_MS) {
    throw new Error('Upload is temporarily unavailable');
  }
  const entry: UploadCacheEntry = cached ?? {};
  const controller = new AbortController();
  entry.controller = controller;
  uploadCache.set(key, entry);
  const promise = authenticatedFetch(
    `${getDaemonUrl().replace(/\/$/, '')}/uploads/${encodeURIComponent(uploadRef)}/${variant}`,
    { cache: 'force-cache', signal: controller.signal },
    { daemonUrl: getDaemonUrl() }
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      // Logout/cache clearing must also invalidate requests already in flight.
      if (uploadCache.get(key) !== entry || key !== cacheKey(uploadRef, variant)) {
        throw new Error('Upload account changed');
      }
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
      entry.controller = undefined;
    });
  entry.promise = promise;
  return promise;
}

export function clearAuthenticatedUploadCache(): void {
  for (const entry of uploadCache.values()) {
    entry.controller?.abort();
    if (entry.loaded) URL.revokeObjectURL(entry.loaded.objectUrl);
  }
  uploadCache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearAuthenticatedUploadCache);
}

/** Original bytes are opt-in. Only visible thumbnails opt into automatic loading. */
export function useAuthenticatedUpload(
  uploadRef: string,
  { variant = 'content', enabled = false }: { variant?: UploadVariant; enabled?: boolean } = {}
) {
  const key = cacheKey(uploadRef, variant);
  const mounted = useRef(false);
  const generation = useRef(0);
  const [state, setState] = useState<{
    key: string;
    loaded?: LoadedUpload;
    loading: boolean;
    unavailable: boolean;
  }>({ key, loaded: uploadCache.get(key)?.loaded, loading: false, unavailable: false });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(
    async (retry: boolean) => {
      const current = ++generation.current;
      setState({ key, loaded: uploadCache.get(key)?.loaded, loading: true, unavailable: false });
      try {
        const loaded = await loadUpload(uploadRef, variant, retry);
        if (mounted.current && generation.current === current)
          setState({ key, loaded, loading: false, unavailable: false });
        return loaded;
      } catch (error) {
        if (mounted.current && generation.current === current)
          setState({ key, loading: false, unavailable: true });
        throw error;
      }
    },
    [key, uploadRef, variant]
  );

  useEffect(() => {
    if (enabled && uploadRef) void request(false).catch(() => {});
  }, [enabled, request, uploadRef]);

  const loaded = state.key === key ? state.loaded : uploadCache.get(key)?.loaded;
  const load = useCallback(() => request(true), [request]);
  return {
    objectUrl: loaded?.objectUrl ?? null,
    blob: loaded?.blob ?? null,
    mimeType: loaded?.mimeType ?? null,
    size: loaded?.size ?? null,
    loading: state.key === key && state.loading,
    unavailable: state.key === key && state.unavailable,
    load,
  };
}
