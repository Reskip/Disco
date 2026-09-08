import type { ContentBlock } from './message';

export type FileCitationPurpose = 'source' | 'output';

export interface FileCitationLocator {
  artifactKind?: string;
  pageNumber?: number;
  sheet?: string;
  range?: string;
  slideNumber?: number;
  slideId?: string;
  objectId?: string;
  objectKind?: string;
  label?: string;
}

export interface FileCitationVisualizationPresentation {
  type: 'visualization';
  mode: 'normal' | 'wide';
  title?: string;
}

export interface ParsedCodexFileCitation {
  raw: string;
  start: number;
  end: number;
  path: string;
  purpose: FileCitationPurpose;
  locator: FileCitationLocator;
  presentation?: FileCitationVisualizationPresentation;
}

export interface FileCitationContentBlock extends ContentBlock {
  type: 'file_citation';
  filename: string;
  purpose: FileCitationPurpose;
  locator?: FileCitationLocator;
  upload_ref?: string;
  mime_type?: string;
  size?: number;
  available: boolean;
  unavailable_reason?: string;
  presentation?: FileCitationVisualizationPresentation;
}

const CODEX_FILE_CITATION_CANDIDATE = /:codex-file-citation\{[^\r\n}]*\}/gu;
const CODEX_VISUALIZATION_CANDIDATE = /visualize(\{[^\r\n]*\})/gu;
const ATTRIBUTE_PATTERN = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:\\.|[^"\\])*)"/gu;

function decodeQuotedAttribute(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAttributes(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of body.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1]] = decodeQuotedAttribute(match[2]);
  }
  return attributes;
}

/** Parse the file-citation directive emitted by the bundled Codex artifact skills. */
export function parseCodexFileCitations(text: string): ParsedCodexFileCitation[] {
  const citations: ParsedCodexFileCitation[] = [];
  for (const match of text.matchAll(CODEX_FILE_CITATION_CANDIDATE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const attributes = parseAttributes(raw.slice(':codex-file-citation{'.length, -1));
    const purpose = attributes.purpose;
    if (!attributes.path || (purpose !== 'source' && purpose !== 'output')) continue;
    const pageNumber = positiveInteger(attributes.page_number);
    const slideNumber = positiveInteger(attributes.slide_number);
    const locator: FileCitationLocator = {
      ...(attributes.artifact_kind ? { artifactKind: attributes.artifact_kind } : {}),
      ...(pageNumber ? { pageNumber } : {}),
      ...(attributes.sheet ? { sheet: attributes.sheet } : {}),
      ...(attributes.range ? { range: attributes.range } : {}),
      ...(slideNumber ? { slideNumber } : {}),
      ...(attributes.slide_id ? { slideId: attributes.slide_id } : {}),
      ...(attributes.object_id ? { objectId: attributes.object_id } : {}),
      ...(attributes.object_kind ? { objectKind: attributes.object_kind } : {}),
      ...(attributes.label ? { label: attributes.label } : {}),
    };
    citations.push({
      raw,
      start,
      end: start + raw.length,
      path: attributes.path,
      purpose,
      locator,
    });
  }
  for (const match of text.matchAll(CODEX_VISUALIZATION_CANDIDATE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    try {
      const payload = JSON.parse(match[1] ?? '') as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const candidate = payload as Record<string, unknown>;
      if (typeof candidate.path !== 'string' || !candidate.path.trim()) continue;
      if (candidate.mode !== undefined && candidate.mode !== 'wide') continue;
      if (candidate.title !== undefined && typeof candidate.title !== 'string') continue;
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      citations.push({
        raw,
        start,
        end: start + raw.length,
        path: candidate.path.trim(),
        purpose: 'output',
        locator: {
          artifactKind: 'visualization',
          ...(title ? { label: title } : {}),
        },
        presentation: {
          type: 'visualization',
          mode: candidate.mode === 'wide' ? 'wide' : 'normal',
          ...(title ? { title } : {}),
        },
      });
    } catch {
      // Malformed host directives are scrubbed by replaceCodexFileCitations.
    }
  }
  return citations.sort((left, right) => left.start - right.start);
}

export function formatFileCitationLocator(locator: FileCitationLocator | undefined): string {
  if (!locator) return '';
  const parts: string[] = [];
  if (locator.label) parts.push(locator.label);
  if (locator.pageNumber) parts.push(`第 ${locator.pageNumber} 页`);
  if (locator.sheet) parts.push(`工作表 ${locator.sheet}`);
  if (locator.range) parts.push(locator.range);
  if (locator.slideNumber) parts.push(`第 ${locator.slideNumber} 页幻灯片`);
  else if (locator.slideId) parts.push(`幻灯片 ${locator.slideId}`);
  if (locator.objectKind || locator.objectId) {
    parts.push([locator.objectKind, locator.objectId].filter(Boolean).join(' '));
  }
  return [...new Set(parts)].join(' · ');
}

/**
 * Remove completed protocol directives from prose while leaving a short,
 * readable filename marker at the exact citation position.
 */
export function replaceCodexFileCitations(
  text: string,
  replacement: (citation: ParsedCodexFileCitation) => string
): string {
  const parsed = parseCodexFileCitations(text);
  if (parsed.length === 0) {
    return text
      .replace(CODEX_FILE_CITATION_CANDIDATE, '（文件引用无法解析）')
      .replace(CODEX_VISUALIZATION_CANDIDATE, '（可视化无法解析）');
  }
  let cursor = 0;
  let result = '';
  for (const citation of parsed) {
    result += text.slice(cursor, citation.start);
    result += replacement(citation);
    cursor = citation.end;
  }
  result += text.slice(cursor);
  return result
    .replace(CODEX_FILE_CITATION_CANDIDATE, '（文件引用无法解析）')
    .replace(CODEX_VISUALIZATION_CANDIDATE, '（可视化无法解析）');
}
