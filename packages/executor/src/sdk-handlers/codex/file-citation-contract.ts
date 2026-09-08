import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DISCO_MCP_METHOD_NAMES,
  type FileCitationContentBlock,
  formatFileCitationLocator,
  inferPublishedFileMimeType,
  isUploadRef,
  type ParsedCodexFileCitation,
  parseCodexFileCitations,
  replaceCodexFileCitations,
  type SessionID,
  type UploadPromptAttachment,
} from '@disco/core';
import {
  type ArtifactPublicationToolUse,
  publishGeneratedArtifacts,
} from './generated-artifact-publication.js';

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function comparablePath(workingDirectory: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workingDirectory, filePath);
  const normalized = path.normalize(absolute).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${path.sep}`) && fromRoot !== '..' && !path.isAbsolute(fromRoot))
  );
}

function publicationOperation(toolUse: ArtifactPublicationToolUse): string | undefined {
  return toolUse.name.split('.').at(-1);
}

function publicationInputPaths(toolUse: ArtifactPublicationToolUse): string[] {
  const operation = publicationOperation(toolUse);
  if (
    operation !== DISCO_MCP_METHOD_NAMES.filesPublish &&
    operation !== DISCO_MCP_METHOD_NAMES.execute
  ) {
    return [];
  }
  const input =
    operation === DISCO_MCP_METHOD_NAMES.execute ? record(toolUse.input.arguments) : toolUse.input;
  if (
    operation === DISCO_MCP_METHOD_NAMES.execute &&
    toolUse.input.tool_name !== DISCO_MCP_METHOD_NAMES.filesPublish
  ) {
    return [];
  }
  return Array.isArray(input?.files)
    ? input.files.flatMap((candidate) => {
        const filePath = record(candidate)?.path;
        return typeof filePath === 'string' && filePath.trim() ? [filePath.trim()] : [];
      })
    : [];
}

function publicationPayloads(output: ArtifactPublicationToolUse['output']): unknown[] {
  if (typeof output === 'string') {
    try {
      return [JSON.parse(output) as unknown];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(output)) return [];
  return output.flatMap((block) => {
    const value = record(block)?.text;
    if (typeof value !== 'string') return [];
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      return [];
    }
  });
}

function publicationAttachments(toolUse: ArtifactPublicationToolUse): UploadPromptAttachment[] {
  if (toolUse.status === 'failed' || toolUse.status === 'error') return [];
  return publicationPayloads(toolUse.output).flatMap((value) => {
    const payload = record(value);
    if (
      payload?.type !== 'disco_file_publication' ||
      payload.published !== true ||
      !Array.isArray(payload.files)
    ) {
      return [];
    }
    return payload.files.flatMap((candidate) => {
      const file = record(candidate);
      return typeof file?.ref === 'string' &&
        typeof file.filename === 'string' &&
        typeof file.mimeType === 'string' &&
        typeof file.size === 'number' &&
        Number.isFinite(file.size)
        ? [
            {
              ref: file.ref,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
            },
          ]
        : [];
    });
  });
}

function publishedByPath(input: {
  workingDirectory: string;
  toolUses: ReadonlyArray<ArtifactPublicationToolUse>;
}): Map<string, UploadPromptAttachment> {
  const published = new Map<string, UploadPromptAttachment>();
  for (const toolUse of input.toolUses) {
    const paths = publicationInputPaths(toolUse);
    const attachments = publicationAttachments(toolUse);
    for (let index = 0; index < Math.min(paths.length, attachments.length); index += 1) {
      published.set(comparablePath(input.workingDirectory, paths[index]!), attachments[index]!);
    }
  }
  return published;
}

function stagedUploadParts(input: {
  citation: ParsedCodexFileCitation;
  workingDirectory: string;
  sessionId: SessionID;
}): { absolutePath: string; filename: string; uploadRef: string } | undefined {
  const absolutePath = path.isAbsolute(input.citation.path)
    ? path.resolve(input.citation.path)
    : path.resolve(input.workingDirectory, input.citation.path);
  if (!isInside(input.workingDirectory, absolutePath)) return undefined;
  const relativePath = path.relative(input.workingDirectory, absolutePath).replaceAll('\\', '/');
  const match = relativePath.match(/^\.disco\/session-staging\/([^/]+)\/(upl_[^/]+)\/(.+)$/u);
  if (!match || match[1] !== input.sessionId || !isUploadRef(match[2])) return undefined;
  return { absolutePath, uploadRef: match[2], filename: path.basename(match[3]) };
}

async function stagedCitationBlock(input: {
  citation: ParsedCodexFileCitation;
  workingDirectory: string;
  sessionId: SessionID;
}): Promise<FileCitationContentBlock | undefined> {
  if (input.citation.purpose !== 'source') return undefined;
  const staged = stagedUploadParts(input);
  if (!staged) return undefined;
  try {
    const fileStat = await stat(staged.absolutePath);
    if (!fileStat.isFile()) return undefined;
    return {
      type: 'file_citation',
      filename: staged.filename,
      purpose: input.citation.purpose,
      ...(Object.keys(input.citation.locator).length ? { locator: input.citation.locator } : {}),
      ...(input.citation.presentation ? { presentation: input.citation.presentation } : {}),
      upload_ref: staged.uploadRef,
      mime_type: inferPublishedFileMimeType(staged.filename),
      size: fileStat.size,
      available: true,
    };
  } catch {
    return undefined;
  }
}

function unavailableBlock(citation: ParsedCodexFileCitation): FileCitationContentBlock {
  const filename = path.basename(citation.path) || '文件';
  return {
    type: 'file_citation',
    filename,
    purpose: citation.purpose,
    ...(Object.keys(citation.locator).length ? { locator: citation.locator } : {}),
    ...(citation.presentation ? { presentation: citation.presentation } : {}),
    mime_type: inferPublishedFileMimeType(filename),
    available: false,
    unavailable_reason: '文件未能发布',
  };
}

function citationKey(block: FileCitationContentBlock): string {
  return JSON.stringify([
    block.upload_ref ?? block.filename,
    block.purpose,
    block.locator ?? null,
    block.presentation ?? null,
    block.available,
  ]);
}

export interface ResolveCodexFileCitationsResult {
  text: string;
  citations: FileCitationContentBlock[];
  content: Array<{ type: 'text'; text: string } | FileCitationContentBlock>;
  publicationToolUses: ArtifactPublicationToolUse[];
}

function appendTextBlock(
  content: Array<{ type: 'text'; text: string } | FileCitationContentBlock>,
  text: string
): void {
  if (!text) return;
  const previous = content.at(-1);
  if (previous?.type === 'text') {
    previous.text += text;
  } else {
    content.push({ type: 'text', text });
  }
}

function sanitizeUnparsedCitationText(text: string): string {
  return replaceCodexFileCitations(text, (citation) => path.basename(citation.path) || '文件');
}

/**
 * Resolve completed Codex file-citation directives against Disco's upload
 * contract. Staged inputs keep their existing opaque ref; every other file is
 * published through the same authenticated MCP method used by the Agent.
 */
export async function resolveCodexFileCitations(input: {
  text: string;
  workingDirectory: string;
  sessionId: SessionID;
  daemonUrl: string;
  sessionToken: string | undefined;
  priorToolUses?: ReadonlyArray<ArtifactPublicationToolUse>;
  fetchImpl?: FetchLike;
}): Promise<ResolveCodexFileCitationsResult> {
  const parsed = parseCodexFileCitations(input.text);
  if (parsed.length === 0) {
    const text = replaceCodexFileCitations(input.text, () => '');
    return {
      text,
      citations: [],
      content: text ? [{ type: 'text', text }] : [],
      publicationToolUses: [],
    };
  }

  const blocks = new Map<number, FileCitationContentBlock>();
  for (let index = 0; index < parsed.length; index += 1) {
    const staged = await stagedCitationBlock({
      citation: parsed[index]!,
      workingDirectory: input.workingDirectory,
      sessionId: input.sessionId,
    });
    if (staged) blocks.set(index, staged);
  }

  const prior = publishedByPath({
    workingDirectory: input.workingDirectory,
    toolUses: input.priorToolUses ?? [],
  });
  const pendingPaths = new Map<string, string>();
  for (let index = 0; index < parsed.length; index += 1) {
    if (blocks.has(index)) continue;
    const citation = parsed[index]!;
    const key = comparablePath(input.workingDirectory, citation.path);
    const existing = prior.get(key);
    if (existing) {
      blocks.set(index, {
        type: 'file_citation',
        filename: existing.filename,
        purpose: citation.purpose,
        ...(Object.keys(citation.locator).length ? { locator: citation.locator } : {}),
        ...(citation.presentation ? { presentation: citation.presentation } : {}),
        upload_ref: existing.ref,
        mime_type: existing.mimeType,
        size: existing.size,
        available: true,
      });
    } else {
      pendingPaths.set(key, citation.path);
    }
  }

  const publicationToolUses = await publishGeneratedArtifacts({
    daemonUrl: input.daemonUrl,
    sessionToken: input.sessionToken,
    filePaths: [...pendingPaths.values()],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const published = publishedByPath({
    workingDirectory: input.workingDirectory,
    toolUses: publicationToolUses,
  });
  for (let index = 0; index < parsed.length; index += 1) {
    if (blocks.has(index)) continue;
    const citation = parsed[index]!;
    const attachment = published.get(comparablePath(input.workingDirectory, citation.path));
    blocks.set(
      index,
      attachment
        ? {
            type: 'file_citation',
            filename: attachment.filename,
            purpose: citation.purpose,
            ...(Object.keys(citation.locator).length ? { locator: citation.locator } : {}),
            ...(citation.presentation ? { presentation: citation.presentation } : {}),
            upload_ref: attachment.ref,
            mime_type: attachment.mimeType,
            size: attachment.size,
            available: true,
          }
        : unavailableBlock(citation)
    );
  }

  const deduplicated = new Map<string, FileCitationContentBlock>();
  for (const block of blocks.values()) deduplicated.set(citationKey(block), block);
  const filenameByRaw = new Map(parsed.map((citation, index) => [citation.raw, blocks.get(index)]));
  const text = replaceCodexFileCitations(input.text, (citation) => {
    const block = filenameByRaw.get(citation.raw) ?? unavailableBlock(citation);
    const locator = formatFileCitationLocator(block.locator);
    const displayName = block.presentation?.title || block.filename;
    return `${displayName}${locator && locator !== displayName ? `（${locator}）` : ''}`;
  });

  // Keep the host-native card at the exact place where Codex cited it. The
  // text-only projection above remains for previews/backward compatibility;
  // the ordered content is the canonical persisted assistant response.
  const content: Array<{ type: 'text'; text: string } | FileCitationContentBlock> = [];
  const placed = new Set<string>();
  let cursor = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const citation = parsed[index]!;
    appendTextBlock(
      content,
      sanitizeUnparsedCitationText(input.text.slice(cursor, citation.start))
    );
    const block = blocks.get(index) ?? unavailableBlock(citation);
    const key = citationKey(block);
    if (!placed.has(key)) {
      content.push(block);
      placed.add(key);
    } else {
      const locator = formatFileCitationLocator(block.locator);
      const displayName = block.presentation?.title || block.filename;
      appendTextBlock(
        content,
        `${displayName}${locator && locator !== displayName ? `（${locator}）` : ''}`
      );
    }
    cursor = citation.end;
  }
  appendTextBlock(content, sanitizeUnparsedCitationText(input.text.slice(cursor)));

  return {
    text,
    citations: [...deduplicated.values()],
    content,
    publicationToolUses,
  };
}

const RICH_REFERENCE_TOKENS = [
  { start: ':codex-file-citation{', end: '}' },
  { start: 'visualize', end: '' },
] as const;

function retainedTokenPrefix(value: string): number {
  const maxTokenLength = Math.max(...RICH_REFERENCE_TOKENS.map((token) => token.start.length));
  const max = Math.min(value.length, maxTokenLength - 1);
  for (let length = max; length > 0; length -= 1) {
    if (RICH_REFERENCE_TOKENS.some((token) => token.start.startsWith(value.slice(-length)))) {
      return length;
    }
  }
  return 0;
}

function nextRichReference(
  value: string
): { index: number; start: string; end: string } | undefined {
  let next: { index: number; start: string; end: string } | undefined;
  for (const token of RICH_REFERENCE_TOKENS) {
    const index = value.indexOf(token.start);
    if (index >= 0 && (!next || index < next.index)) next = { index, ...token };
  }
  return next;
}

/** Hide complete or split protocol directives from token-level UI streaming. */
export class CodexFileCitationStreamFilter {
  private pending = '';

  push(chunk: string): string {
    this.pending += chunk;
    let visible = '';
    while (this.pending) {
      const reference = nextRichReference(this.pending);
      if (!reference) {
        const retained = retainedTokenPrefix(this.pending);
        visible += retained ? this.pending.slice(0, -retained) : this.pending;
        this.pending = retained ? this.pending.slice(-retained) : '';
        return visible;
      }
      visible += this.pending.slice(0, reference.index);
      const referenceEnd = this.pending.indexOf(
        reference.end,
        reference.index + reference.start.length
      );
      if (referenceEnd < 0) {
        this.pending = this.pending.slice(reference.index);
        return visible;
      }
      this.pending = this.pending.slice(referenceEnd + reference.end.length);
    }
    return visible;
  }

  reset(): void {
    this.pending = '';
  }
}
