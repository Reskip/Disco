/**
 * Single source of truth for Disco's user-facing web branding.
 *
 * Every web surface in this app (Workspace, Settings, Artifact fullscreen, …)
 * consumes these helpers so favicon/title metadata can't drift as new surfaces
 * are added. See surfaceRegistry.ts for the per-surface branding declarations
 * and brand.test.ts / surfaceRegistry.test.ts for the regression guards.
 *
 * The docs site (apps/disco-docs) is a standalone Next.js package with
 * deliberately distinct branding (lowercase "disco" wordmark, en-dash title
 * separator, social-card metadata). It centralizes its own constants in
 * apps/disco-docs/lib/siteMetadata.ts and cannot import this module.
 */

export const BRAND = {
  /** Wordmark used in document titles and accessible product naming. */
  name: 'Disco',
  /** Transparent mark variants tuned for light and dark application surfaces. */
  markFiles: {
    light: 'disco-mark-light.svg',
    dark: 'disco-mark-dark.svg',
  },
  /** Standalone logo variants; the mark and wordmark remain separate assets. */
  logoFiles: {
    light: 'disco-logo-light.svg',
    dark: 'disco-logo-dark.svg',
  },
  /** The light-surface mark remains legible in browser favicon plates. */
  badgeFile: 'disco-mark-light.svg',
  /** Separator between a surface label and the brand name in tab titles. */
  titleSeparator: ' · ',
} as const;

/**
 * Absolute, base-aware URL to the transparent Disco mark asset.
 *
 * MUST be absolute (base-prefixed), never a bare relative filename: SPA
 * surfaces live at nested paths (e.g. `/ui/s/<session-id>`) and a
 * relative href resolves against the current document URL → 404. This is the
 * class of bug that makes favicons disappear on deep links.
 */
export function brandMarkHref(
  baseUrl: string = import.meta.env.BASE_URL,
  appearance: keyof typeof BRAND.markFiles = 'light'
): string {
  return `${baseUrl}${BRAND.markFiles[appearance]}`;
}

export function brandLogoHref(
  baseUrl: string = import.meta.env.BASE_URL,
  appearance: keyof typeof BRAND.logoFiles = 'light'
): string {
  return `${baseUrl}${BRAND.logoFiles[appearance]}`;
}

/** Absolute, base-aware URL to the backed badge asset used by favicons. */
export function brandBadgeHref(baseUrl: string = import.meta.env.BASE_URL): string {
  return `${baseUrl}${BRAND.badgeFile}`;
}

/** Build a document title for a surface, e.g. `surfaceTitle('Settings')` → "Settings · Disco". */
export function surfaceTitle(label?: string | null): string {
  return label ? `${label}${BRAND.titleSeparator}${BRAND.name}` : BRAND.name;
}
