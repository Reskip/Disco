import type { KnowledgeEntry, KnowledgeEntryDetail } from '@disco/core/types';

const stopWords = new Set([
  '什么',
  '怎么',
  '为何',
  '如何',
  '这个',
  '那个',
  '一下',
  '是否',
  '时候',
  '可以',
  '需要',
  'the',
  'and',
  'for',
  'with',
  'what',
  'when',
  'where',
  'which',
  'how',
  'does',
  'was',
  'are',
  'is',
  'to',
  'of',
  'in',
]);

interface Terms {
  counts: Map<string, number>;
  length: number;
}

/** Linear Unicode scan: unknown Chinese compounds and exact technical IDs both survive. */
function* tokens(text: string): Generator<string> {
  for (const match of text
    .toLocaleLowerCase()
    .matchAll(/\p{Script=Han}+|[a-z0-9]+(?:[_.:/-][a-z0-9]+)*/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}/u.test(token)) {
      let previous = '';
      let count = 0;
      for (const character of token) {
        yield character;
        if (previous) yield previous + character;
        previous = character;
        count++;
      }
      if (count > 2 && count <= 12) yield token;
    } else {
      yield token;
      for (const part of token.split(/[_.:/-]+/)) if (part.length > 1 && part !== token) yield part;
    }
  }
}

function terms(text: string): Terms {
  const counts = new Map<string, number>();
  let length = 0;
  for (const term of tokens(text)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
    length++;
  }
  return { counts, length };
}

async function bodyTerms(text: string): Promise<Terms> {
  const counts = new Map<string, number>();
  let length = 0;
  for (const term of tokens(text)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
    length++;
    // Pure text computation, outside a database transaction. Yield periodically
    // so the first search of a large archive cannot freeze chat HTTP/realtime.
    if (length % 32_768 === 0) await new Promise<void>((done) => setTimeout(done, 0));
  }
  return { counts, length };
}

export function searchTerms(query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  // A lone technical identifier is an exact lookup; common underscore or path
  // components must not manufacture unrelated keyword matches.
  if (/^[a-z0-9]+(?:[_.:/-]+[a-z0-9]+)+$/.test(normalized)) return [normalized];
  return [...terms(normalized).counts.keys()].filter(
    (term) => !stopWords.has(term) && (term.length > 1 || normalized.length === 1)
  );
}

function metadata(entry: KnowledgeEntry): string {
  return [
    entry.title,
    entry.organization?.topic,
    entry.organization?.summary,
    ...(entry.organization?.tags ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}

interface IndexedDocument {
  signature: string;
  contentHash: string;
  body: Terms;
  metadata: Terms;
}

export interface KeywordHit {
  id: string;
  score: number;
  contentHash: string;
}

/** Rebuildable, owner-scoped sparse counts; original Markdown is never cached here. */
export class KnowledgeKeywordIndex {
  private readonly owners = new Map<string, Map<string, IndexedDocument>>();

  clear(): void {
    this.owners.clear();
  }

  async search(
    owner: string,
    entries: KnowledgeEntry[],
    liveIds: Set<string>,
    query: string,
    load: (id: string) => Promise<KnowledgeEntryDetail | null>,
    limit: number
  ): Promise<KeywordHit[]> {
    const queryTerms = searchTerms(query);
    if (!queryTerms.length) return [];
    const cache = this.owners.get(owner) ?? new Map<string, IndexedDocument>();
    // LRU bounds memory across accounts; eviction changes speed, never search scope/results.
    this.owners.delete(owner);
    this.owners.set(owner, cache);
    while (this.owners.size > 8) this.owners.delete(this.owners.keys().next().value!);
    for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
    const documents: Array<{ id: string; value: IndexedDocument }> = [];
    for (const entry of entries) {
      const signature = `${entry.updatedAt}\n${entry.sizeBytes}\n${metadata(entry)}`;
      let value = cache.get(entry.id);
      if (!value || value.signature !== signature) {
        const detail = await load(entry.id).catch(() => null);
        if (!detail || detail.entry.historical) {
          cache.delete(entry.id);
          continue;
        }
        value = {
          signature: `${detail.entry.updatedAt}\n${detail.entry.sizeBytes}\n${metadata(detail.entry)}`,
          contentHash: detail.contentHash,
          body: await bodyTerms(detail.markdown),
          metadata: terms(metadata(detail.entry)),
        };
        cache.set(entry.id, value);
      }
      documents.push({ id: entry.id, value });
    }
    const averageLength =
      documents.reduce((sum, document) => sum + document.value.body.length, 0) /
      Math.max(1, documents.length);
    const weights = new Map(
      queryTerms.map((term) => {
        const frequency = documents.filter(
          ({ value }) => value.body.counts.has(term) || value.metadata.counts.has(term)
        ).length;
        return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
      })
    );
    const results: KeywordHit[] = [];
    for (const { id, value } of documents) {
      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const bodyCount = value.body.counts.get(term) ?? 0;
        const metadataCount = value.metadata.counts.get(term) ?? 0;
        if (!bodyCount && !metadataCount) continue;
        matched++;
        const normalizedBody =
          (bodyCount * 2.2) /
          (bodyCount + 1.2 * (0.25 + (0.75 * value.body.length) / Math.max(1, averageLength)));
        score += weights.get(term)! * (normalizedBody + Math.min(metadataCount, 3) * 1.5);
      }
      if (matched)
        results.push({
          id,
          score: score * (0.35 + (0.65 * matched) / queryTerms.length),
          contentHash: value.contentHash,
        });
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }
}

export interface KnowledgeMatch {
  method: 'semantic' | 'keyword' | 'hybrid';
  /** UTF-16 character offsets, matching the paged knowledge read API. */
  start: number;
  end: number;
  contentHash: string;
}

export function keywordPosition(text: string, query: string): number | undefined {
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrase = query.trim()
    ? new RegExp(literal(query.trim()), 'iu').exec(text)?.index
    : undefined;
  if (phrase !== undefined) return phrase;
  // Prefer the densest local group of query terms over the first generic word.
  const windows = new Map<number, { position: number; terms: Set<string> }>();
  for (const term of searchTerms(query)) {
    for (const occurrence of text.matchAll(new RegExp(literal(term), 'giu'))) {
      const offset = occurrence.index;
      const bucket = Math.floor(offset / 800);
      for (const key of [bucket, bucket - 1]) {
        const window = windows.get(key) ?? { position: offset, terms: new Set<string>() };
        window.position = Math.min(window.position, offset);
        window.terms.add(term);
        windows.set(key, window);
      }
    }
  }
  let best: number | undefined;
  let maximum = 0;
  for (const window of windows.values()) {
    if (
      window.terms.size > maximum ||
      (window.terms.size === maximum && (best === undefined || window.position < best))
    ) {
      maximum = window.terms.size;
      best = window.position;
    }
  }
  return best;
}

export function hasKeywordMatch(detail: KnowledgeEntryDetail, query: string): boolean {
  const text = `${metadata(detail.entry)}\n${detail.markdown}`.toLocaleLowerCase();
  return searchTerms(query).some((term) => text.includes(term));
}

/** A provider excerpt is evidence only if its exact bytes still occur in this owner's current source. */
export function verifiedSemanticPosition(markdown: string, content: string): number | undefined {
  if (!content.trim()) return undefined;
  const position = markdown.indexOf(content);
  return position < 0 ? undefined : position;
}

export function searchExcerpt(
  detail: KnowledgeEntryDetail,
  query: string,
  method: KnowledgeMatch['method'],
  semantic?: { position: number; length: number }
): { excerpt: string; match: KnowledgeMatch } {
  const position = semantic?.position ?? keywordPosition(detail.markdown, query) ?? 0;
  const start = Math.max(0, position - 120);
  const end = Math.min(
    detail.markdown.length,
    start + Math.min(3600, Math.max(1800, (semantic?.length ?? 0) + 240))
  );
  return {
    excerpt: detail.markdown.slice(start, end),
    match: { method, start, end, contentHash: detail.contentHash },
  };
}

export function fuseSearchRanks(
  semantic: string[],
  keyword: string[]
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of [semantic, keyword]) {
    const unique = [...new Set(ranking)];
    unique.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
