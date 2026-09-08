import { useMemo } from 'react';

export interface HighlightedSearchTextProps {
  text: string;
  query: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const HighlightedSearchText: React.FC<HighlightedSearchTextProps> = ({ text, query }) => {
  const matcher = useMemo(() => {
    const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp);
    return terms.length > 0 ? new RegExp(terms.join('|'), 'giu') : null;
  }, [query]);

  if (!matcher) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <strong className="disco-search-match" key={`${index}-${match[0]}`}>
        {match[0]}
      </strong>
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
};
