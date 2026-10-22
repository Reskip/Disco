import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { KnowledgeEntry, KnowledgeSourceInput, Message } from '@disco/core/types';

type RecordValue = Record<string, unknown>;

export interface HostRolloutSource extends KnowledgeSourceInput {
  /** Source metadata only. A transcript cwd is never an automatically authorized root. */
  sessionCwd?: string;
  sessionCwds: string[];
}

export interface HostAttachmentReference {
  reference: string;
  role: 'user' | 'assistant';
  origin: 'local-image' | 'markdown-link' | 'attachment-text';
  sourceLine: number;
  sourceTimestamp?: string;
  cwd?: string;
}

export interface HostAttachmentResolution extends HostAttachmentReference {
  status: 'available' | 'missing' | 'outside-roots' | 'unresolved';
  path?: string;
  reason?: string;
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const eventTime = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}

/** App-injected context is retained in raw archives, not presented as a user's question. */
export function hostVisibleMessage(text: string): string {
  let visible = text.trim();
  while (true) {
    const stripped = visible.replace(
      /^\s*<(environment_context|recommended_plugins|external_codex_apps_open_page|skills_instructions|permissions_instructions|collaboration_mode)>[\s\S]*?<\/\1>\s*/,
      ''
    );
    if (stripped === visible) return visible;
    visible = stripped.trim();
  }
}

export function hostConversationTitle(text: string): string {
  const visible = hostVisibleMessage(text);
  const request = /(?:^|\n)## My request:\s*\n([\s\S]*)/.exec(visible)?.[1] ?? visible;
  return request.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Render human conversation text; the untouched JSONL remains the complete record. */
export function conversationText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((value) => {
      const block = record(value);
      if (typeof block.text === 'string') return block.text;
      if (['image', 'input_image', 'local_image', 'localImage'].includes(String(block.type))) {
        return '[图片，原始引用保存在会话记录中]';
      }
      if (block.type === 'tool_use') return `工具调用：${String(block.name ?? '')}`;
      if (block.type === 'tool_result') return '工具结果：见完整原始记录';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function discoConversationSource(input: {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
}): KnowledgeSourceInput {
  const sections = input.messages.map((message) => {
    const text = conversationText(message.content);
    return `## ${message.role} · ${message.timestamp}\n\n${text || '（工具或结构化记录，见原始 JSONL）'}`;
  });
  return {
    source: 'disco',
    sourceId: input.id,
    kind: 'conversation',
    title: input.title,
    sourceUpdatedAt: input.updatedAt,
    sourceUrl: `/s/${input.id}/`,
    markdown: `# ${input.title}\n\n来源：Disco 会话 ${input.id}\n\n${sections.join('\n\n')}`,
    rawContent: `${input.messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
  };
}

/** Only the two explicit Codex transcript trees; never auth, config, SQLite or runtime homes. */
export async function* hostRolloutFiles(codexHome: string): AsyncGenerator<string> {
  const root = await realpath(codexHome);
  async function* walk(directory: string): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
    }
  }
  yield* walk(join(root, 'sessions'));
  yield* walk(join(root, 'archived_sessions'));
}

export async function readHostRollout(path: string): Promise<HostRolloutSource | null> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const raw = await readFile(path, 'utf8');
  const after = await lstat(path);
  // A concurrently-written tail is retried on the next pass, never checkpointed as complete.
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
    return null;
  let id = '';
  let agentPath: string | undefined;
  const messages: string[] = [];
  const fallback: string[] = [];
  let title = '';
  let fallbackTitle = '';
  let firstEventAt: string | undefined;
  let lastEventAt: string | undefined;
  let recordCount = 0;
  let malformedRecords = 0;
  const sessionCwds = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: RecordValue;
    try {
      row = record(JSON.parse(line.replace(/^\uFEFF/, '')));
    } catch {
      malformedRecords++;
      continue;
    }
    recordCount++;
    const payload = record(row.payload);
    const timestamp = eventTime(row.timestamp) ?? eventTime(payload.timestamp);
    if (timestamp) {
      if (!firstEventAt || timestamp < firstEventAt) firstEventAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }
    if (
      ['session_meta', 'turn_context'].includes(String(row.type)) &&
      typeof payload.cwd === 'string'
    )
      sessionCwds.add(payload.cwd);
    // Forked Codex transcripts contain inherited session_meta records after their
    // own header. The first header owns this file; later headers are provenance.
    if (!id && row.type === 'session_meta' && typeof payload.id === 'string' && payload.id) {
      id = payload.id;
      const threadSpawn = record(record(record(payload.source).subagent).thread_spawn);
      if (typeof threadSpawn.agent_path === 'string') agentPath = threadSpawn.agent_path;
    }
    if (row.type === 'response_item' && payload.type === 'message') {
      const role = String(payload.role ?? '');
      if (!['user', 'assistant'].includes(role)) continue;
      const text = hostVisibleMessage(conversationText(payload.content));
      if (!text) continue;
      if (!title && role === 'user') title = hostConversationTitle(text);
      messages.push(`## ${role} · ${String(row.timestamp ?? '')}\n\n${text}`);
    } else if (
      row.type === 'event_msg' &&
      ['user_message', 'agent_message'].includes(String(payload.type))
    ) {
      const text = hostVisibleMessage(String(payload.message ?? ''));
      if (!fallbackTitle && payload.type === 'user_message')
        fallbackTitle = hostConversationTitle(text);
      if (text)
        fallback.push(
          `## ${payload.type === 'user_message' ? 'user' : 'assistant'} · ${String(row.timestamp ?? '')}\n\n${text}`
        );
    }
  }
  if (!id) return null;
  title = agentPath
    ? `Codex 子任务 · ${agentPath.replace(/^\/root\//, '')}`
    : title || fallbackTitle;
  return {
    source: 'codex',
    sourceId: id,
    title: title || `Codex 会话 ${id}`,
    kind: 'conversation',
    // A copied file's mtime says nothing about the conversation's semantic freshness.
    sourceUpdatedAt: lastEventAt ?? new Date(0).toISOString(),
    sourceUrl: `codex://threads/${id}`,
    markdown: `# ${title || 'Codex 会话'}\n\n来源：Codex 会话 ${id}\n\n${(messages.length ? messages : fallback).join('\n\n')}`,
    rawContent: raw,
    sourceVersion: {
      kind: 'codex-rollout',
      sha256: sha256(raw),
      byteLength: Buffer.byteLength(raw),
      recordCount,
      firstEventAt,
      lastEventAt,
      complete: malformedRecords === 0,
      malformedRecords,
      visibleMessages: messages.length || fallback.length,
    },
    sessionCwd: [...sessionCwds][0],
    sessionCwds: [...sessionCwds],
  };
}

/** Prefer a provable append-only extension. Divergent copies require explicit preservation/review. */
export function compareHostRolloutSource(
  candidate: KnowledgeSourceInput,
  previous?: Pick<KnowledgeEntry, 'sourceVersion' | 'sourceUpdatedAt'>
): 'newer' | 'same' | 'older' | 'conflict' {
  const incoming = candidate.sourceVersion;
  const old = previous?.sourceVersion;
  if (!previous || !old) return 'newer'; // Establish provenance once for legacy metadata.
  if (incoming?.kind !== 'codex-rollout' || old.kind !== 'codex-rollout') return 'conflict';
  if (incoming.sha256 === old.sha256) return 'same';
  const bytes = Buffer.from(candidate.rawContent ?? '', 'utf8');
  if (
    incoming.byteLength > old.byteLength &&
    bytes.byteLength === incoming.byteLength &&
    sha256(bytes.subarray(0, old.byteLength)) === old.sha256
  )
    return 'newer';
  const incomingTime = Date.parse(incoming.lastEventAt ?? '') || 0;
  const oldTime = Date.parse(old.lastEventAt ?? '') || 0;
  if (
    incoming.byteLength <= old.byteLength &&
    incoming.recordCount <= old.recordCount &&
    incomingTime <= oldTime
  )
    return 'older';
  return 'conflict';
}

export async function hostRolloutIdentity(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stream = handle.createReadStream({ encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        if (!line.trim()) continue;
        const row = record(JSON.parse(line.replace(/^\uFEFF/, '')));
        if (row.type === 'session_meta') {
          const id = record(row.payload).id;
          return typeof id === 'string' ? id : null;
        }
      } catch {
        /* incomplete metadata is retried */
      }
      return null;
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Host attachments are restricted to explicitly configured attachment roots. */
export async function safeHostAttachment(path: string, roots: string[]): Promise<string | null> {
  try {
    const candidate = await realpath(path);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    for (const root of roots) {
      const boundary = await realpath(root).catch(() => null);
      if (!boundary) continue;
      const rel = relative(boundary, candidate);
      if (
        rel &&
        !isAbsolute(rel) &&
        !rel.startsWith(`..${sep}`) &&
        rel !== '..' &&
        resolve(boundary, rel) === candidate
      )
        return candidate;
    }
  } catch {
    /* source may have been removed; archive the missing provenance */
  }
  return null;
}

function localReference(value: string): string | null {
  let target = value.trim();
  if (!target || target.startsWith('#') || target.startsWith('//')) return null;
  if (/^file:/i.test(target)) {
    try {
      return fileURLToPath(target);
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z]:[\\/]/.test(target) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  target = target
    .split('#')[0]!
    .split('?')[0]!
    .replace(/:\d+(?::\d+)?$/, '');
  try {
    target = decodeURIComponent(target);
  } catch {
    /* Literal percent signs are valid in filenames. */
  }
  return target;
}

/** Parse visible Markdown destinations, including angle-wrapped spaces and balanced parentheses. */
function markdownFileLinks(text: string): string[] {
  const result: string[] = [];
  let fence = '';
  text = text
    .split(/\r?\n/)
    .filter((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
        return false;
      }
      return !fence;
    })
    .join('\n')
    .replace(/`+[^`]*`+/g, '');
  for (const start of text.matchAll(/!?\[[^\]\r\n]*\]\(/g)) {
    let offset = start.index! + start[0].length;
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
    let target = '';
    if (text[offset] === '<') {
      const end = text.indexOf('>', offset + 1);
      if (end < 0) continue;
      target = text.slice(offset + 1, end);
    } else {
      const begin = offset;
      let depth = 1;
      while (offset < text.length && depth) {
        if (text[offset] === '\\' && ['(', ')'].includes(text[offset + 1] ?? '')) {
          offset += 2;
          continue;
        }
        if (text[offset] === '(') depth++;
        if (text[offset] === ')') depth--;
        if (depth) offset++;
      }
      if (depth) continue;
      target = text
        .slice(begin, offset)
        .replace(/\s+["'][^"']*["']\s*$/, '')
        .replace(/\\([()])/g, '$1');
    }
    const local = localReference(target);
    if (local) result.push(local);
  }
  for (const definition of text.matchAll(/^\s*\[[^\]\r\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    const local = localReference(definition[1] ?? definition[2] ?? '');
    if (local) result.push(local);
  }
  return result;
}

export function hostAttachmentProvenance(raw: string): HostAttachmentReference[] {
  const result: HostAttachmentReference[] = [];
  let cwd: string | undefined;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    try {
      const row = record(JSON.parse(lines[index]!.replace(/^\uFEFF/, '')));
      const payload = record(row.payload);
      if (
        ['session_meta', 'turn_context'].includes(String(row.type)) &&
        typeof payload.cwd === 'string'
      )
        cwd = payload.cwd;
      const role =
        row.type === 'response_item' && payload.type === 'message'
          ? payload.role
          : row.type === 'event_msg' && payload.type === 'agent_message'
            ? 'assistant'
            : row.type === 'event_msg' && payload.type === 'user_message'
              ? 'user'
              : undefined;
      if (role !== 'user' && role !== 'assistant') continue;
      const add = (reference: string, origin: HostAttachmentReference['origin']) => {
        if (
          !result.some(
            (item) =>
              item.reference === reference &&
              item.sourceLine === index + 1 &&
              item.origin === origin
          )
        )
          result.push({
            reference,
            role,
            origin,
            sourceLine: index + 1,
            sourceTimestamp: eventTime(row.timestamp),
            cwd,
          });
      };
      const content = payload.content ?? payload.message;
      for (const block of Array.isArray(content)
        ? content
        : typeof content === 'string'
          ? [{ text: content }]
          : []) {
        const item = record(block);
        if (
          ['local_image', 'localImage'].includes(String(item.type)) &&
          typeof item.path === 'string'
        )
          add(item.path, 'local-image');
        if (typeof item.text === 'string') {
          for (const reference of markdownFileLinks(item.text)) add(reference, 'markdown-link');
          if (role === 'user')
            for (const match of item.text.matchAll(
              /[A-Za-z]:[\\/][^\r\n<>"|]*?[\\/]attachments[\\/][^\r\n<>"|]+/g
            ))
              add(match[0].trim().replace(/[)\]`]+$/, ''), 'attachment-text');
        }
      }
    } catch {
      /* the original malformed line is retained unchanged */
    }
  }
  return result;
}

export function hostAttachmentReferences(raw: string): string[] {
  return [...new Set(hostAttachmentProvenance(raw).map((item) => item.reference))];
}

/** Resolves one visible reference only; never discovers or scans its surrounding directory. */
export async function resolveHostAttachment(
  reference: HostAttachmentReference,
  roots: string[],
  cwd?: string
): Promise<HostAttachmentResolution> {
  let path = reference.reference;
  if (!isAbsolute(path)) {
    if (!cwd || !isAbsolute(cwd))
      return { ...reference, status: 'unresolved', reason: '相对路径缺少经授权的工作目录。' };
    path = resolve(cwd, path);
  }
  if (
    !roots.some((root) => {
      if (!isAbsolute(root)) return false;
      const child = relative(resolve(root), resolve(path));
      return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    })
  )
    return { ...reference, status: 'outside-roots', reason: '文件位于未授权目录，未探测或复制。' };
  const exists = await lstat(path).catch(() => null);
  if (!exists)
    return {
      ...reference,
      status: 'missing',
      reason: '原始引用文件已不存在；会话中的原始路径继续保留。',
    };
  const safe = await safeHostAttachment(path, roots);
  return safe
    ? { ...reference, status: 'available', path: safe }
    : {
        ...reference,
        status: 'outside-roots',
        reason: '文件位于未授权目录或不是普通文件，未复制。',
      };
}

export function documentText(name: string, bytes: Uint8Array): string | null {
  if (
    !/\.(md|markdown|txt|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|ts|tsx|jsx|py|sql|log|rst)$/i.test(
      basename(name)
    )
  )
    return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}
