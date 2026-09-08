import { useEffect, useState } from 'react';

export const MOBILE_WORKSPACE_QUERY =
  '(max-width: 840px), (max-width: 960px) and (max-height: 500px)';
export const MOBILE_COMPOSER_QUERY =
  '(max-width: 600px), (max-width: 960px) and (max-height: 500px)';

const readMatch = (query: string) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatch(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);

  return matches;
}
