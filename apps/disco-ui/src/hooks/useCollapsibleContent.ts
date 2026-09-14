import { useEffect, useState } from 'react';

/** Mount details on demand, retaining them only through the 120 ms closing animation. */
export function useCollapsibleContent(expanded: boolean): boolean {
  const [retained, setRetained] = useState(expanded);

  useEffect(() => {
    if (expanded) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const timeout = window.setTimeout(() => setRetained(false), 160);
    return () => window.clearTimeout(timeout);
  }, [expanded, retained]);

  return expanded || retained;
}
