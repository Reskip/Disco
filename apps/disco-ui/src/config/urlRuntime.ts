import { UI_MOUNT_PATH } from '@disco-live/client';

export type UiRuntimeMode =
  | 'bundled-daemon-ui'
  | 'bundled-daemon-root-proxy'
  | 'root-vite-dev'
  | 'canonical-dev-deeplink';

export interface UiRuntime {
  mode: UiRuntimeMode;
  baseUrl: string;
  pathname: string;
  uiMountPath: string;
}

export interface ResolveUiRuntimeOptions {
  /**
   * Vite's compile-time asset/router base. Production/bundled installs build
   * with `/ui/`; branch/dev Vite serves at `/`.
   */
  baseUrl: string;
  /** The browser location pathname at initial load. */
  pathname: string;
  /** Shared daemon UI mount path. Defaults to Disco's canonical `/ui`. */
  uiMountPath?: string;
}

function isUnderMountPath(pathname: string, uiMountPath: string): boolean {
  return pathname === uiMountPath || pathname.startsWith(`${uiMountPath}/`);
}

/**
 * Resolve the UI's URL runtime mode.
 *
 * Keep these concepts intentionally separate:
 * - canonical external app links include `/ui/...`;
 * - bundled installs serve both UI and API from the daemon origin;
 * - branch/dev Vite serves UI at `/` while API stays on the daemon port.
 */
export function resolveUiRuntime({
  baseUrl,
  pathname,
  uiMountPath = UI_MOUNT_PATH,
}: ResolveUiRuntimeOptions): UiRuntime {
  if (baseUrl === `${uiMountPath}/`) {
    return {
      mode: isUnderMountPath(pathname, uiMountPath)
        ? 'bundled-daemon-ui'
        : 'bundled-daemon-root-proxy',
      baseUrl,
      pathname,
      uiMountPath,
    };
  }

  if (baseUrl === '/' && isUnderMountPath(pathname, uiMountPath)) {
    return { mode: 'canonical-dev-deeplink', baseUrl, pathname, uiMountPath };
  }

  return { mode: 'root-vite-dev', baseUrl, pathname, uiMountPath };
}

export function routerBasenameForRuntime(runtime: UiRuntime): string {
  return runtime.mode === 'bundled-daemon-ui' || runtime.mode === 'canonical-dev-deeplink'
    ? runtime.uiMountPath
    : '';
}

export function usesSameOriginDaemon(runtime: UiRuntime): boolean {
  return runtime.mode === 'bundled-daemon-ui' || runtime.mode === 'bundled-daemon-root-proxy';
}

export function daemonUrlForRuntime(
  runtime: UiRuntime,
  origin: string,
  daemonPort: string
): string {
  if (usesSameOriginDaemon(runtime)) return origin;

  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}:${daemonPort}`;
}
