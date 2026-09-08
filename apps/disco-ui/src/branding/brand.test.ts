// biome-ignore-all lint/plugin/noHardcodedColorLiteral: fixed SVG brand fills are the asset regression contract
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, brandBadgeHref, brandLogoHref, brandMarkHref, surfaceTitle } from './brand';

describe('brandMarkHref', () => {
  it('prefixes the mark file with the Vite base path', () => {
    expect(brandMarkHref('/ui/')).toBe('/ui/disco-mark-light.svg');
    expect(brandMarkHref('/', 'dark')).toBe('/disco-mark-dark.svg');
    expect(brandLogoHref('/ui/', 'dark')).toBe('/ui/disco-logo-dark.svg');
    expect(brandBadgeHref('/ui/')).toBe('/ui/disco-mark-light.svg');
  });

  it('returns an absolute (base-rooted) URL, never a bare relative href', () => {
    // A relative href (e.g. "logo.svg") resolves against the current
    // document path and 404s on nested SPA routes like /ui/s/<session-id>.
    for (const base of ['/', '/ui/', '/some/deep/base/']) {
      expect(brandMarkHref(base).startsWith('/')).toBe(true);
    }
  });

  it('defaults to the build-time base path', () => {
    expect(brandMarkHref()).toBe(`${import.meta.env.BASE_URL}${BRAND.markFiles.light}`);
  });

  it.each(['disco-mark-light.svg', 'disco-mark-dark.svg'])('%s stays transparent', (filename) => {
    const mark = readFileSync(path.resolve(process.cwd(), 'public', filename), 'utf8');
    expect(mark).not.toMatch(/<rect[^>]+(?:width="100%"|width="761")/);
  });
});

describe('surfaceTitle', () => {
  it('joins a surface label to the brand name', () => {
    expect(surfaceTitle('Settings')).toBe('Settings · Disco');
  });

  it('returns the bare brand name when no label is given', () => {
    expect(surfaceTitle()).toBe('Disco');
    expect(surfaceTitle(null)).toBe('Disco');
    expect(surfaceTitle('')).toBe('Disco');
  });
});
