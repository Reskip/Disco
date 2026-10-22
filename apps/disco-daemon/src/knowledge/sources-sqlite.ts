import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  conversationText,
  type HostAttachmentReference,
  type HostRolloutSource,
  hostAssistantTitle,
  hostAttachmentProvenance,
  hostConversationTitle,
  hostVisibleMessage,
  needsHostTitleRepair,
} from './sources';

type SqlRow = Record<string, SQLOutputValue>;
type ThreadWatermark = { signature: string; itemCount: number; updatedAtMs: number };

export interface HostSqliteThread {
  id: string;
  title: string;
  cwd: string;
  archived: boolean;
  sourceUpdatedAt: string;
  signature: string;
  itemCount: number;
  sourceRemoved?: boolean;
}

export interface HostSqliteArchive {
  source: HostRolloutSource;
  rawArchive: { path: string; sha256: string; byteLength: number };
  references: HostAttachmentReference[];
}

const iso = (value: unknown): string | undefined => {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : undefined;
};

async function databasePath(home: string, prefix: string): Promise<string | null> {
  const root = await realpath(home);
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(entry.name))
    .map((entry) => entry.name)
    .sort(
      (a, b) =>
        Number(b.match(/_([0-9]+)\.sqlite$/)![1]) - Number(a.match(/_([0-9]+)\.sqlite$/)![1])
    );
  if (!names[0]) return null;
  const path = join(root, names[0]);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('Codex 历史数据库路径不是授权目录中的普通文件。');
  return path;
}

function requireColumns(db: DatabaseSync, table: string, required: string[]): Set<string> {
  // Only fixed internal table names reach this function.
  const columns = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
  );
  if (required.some((name) => !columns.has(name)))
    throw new Error(`Codex 历史数据库结构暂不兼容：${table}。`);
  return columns;
}

async function openDatabases(
  home: string
): Promise<{ state: DatabaseSync; history: DatabaseSync } | null> {
  const [statePath, historyPath] = await Promise.all([
    databasePath(home, 'state'),
    databasePath(home, 'thread_history'),
  ]);
  if (!statePath && !historyPath) return null;
  if (!statePath || !historyPath) throw new Error('Codex 会话目录或历史数据库缺失，等待重试。');
  const state = new DatabaseSync(statePath, { readOnly: true });
  let history: DatabaseSync | undefined;
  try {
    history = new DatabaseSync(historyPath, { readOnly: true });
    state.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    history.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    requireColumns(state, 'threads', ['id', 'title', 'cwd', 'archived', 'updated_at']);
    requireColumns(history, 'thread_items', [
      'thread_id',
      'turn_id',
      'item_id',
      'rollout_ordinal',
      'created_at_ms',
      'item_json',
    ]);
    requireColumns(history, 'thread_turns', ['thread_id', 'turn_id', 'rollout_ordinal', 'status']);
    return { state, history };
  } catch (error) {
    state.close();
    history?.close();
    throw error;
  }
}

function threadWatermarks(history: DatabaseSync, id?: string): Map<string, ThreadWatermark> {
  const columns = requireColumns(history, 'thread_items', [
    'thread_id',
    'rollout_ordinal',
    'created_at_ms',
  ]);
  const update = columns.has('updated_at_ordinal')
    ? 'MAX(updated_at_ordinal)'
    : 'MAX(rollout_ordinal)';
  const sql = `SELECT thread_id, COUNT(*) AS count, MAX(rollout_ordinal) AS ordinal, ${update} AS updated, MAX(created_at_ms) AS created FROM thread_items ${id ? 'WHERE thread_id = ?' : ''} GROUP BY thread_id`;
  const rows = id ? history.prepare(sql).all(id) : history.prepare(sql).all();
  const turns = new Map<string, SqlRow[]>();
  const turnSql = `SELECT * FROM thread_turns ${id ? 'WHERE thread_id = ?' : ''} ORDER BY thread_id, rollout_ordinal, turn_id`;
  for (const row of id ? history.prepare(turnSql).all(id) : history.prepare(turnSql).all()) {
    const key = String(row.thread_id);
    const group = turns.get(key) ?? [];
    group.push(row);
    turns.set(key, group);
  }
  const result = new Map<string, ThreadWatermark>();
  for (const row of rows) {
    const threadId = String(row.thread_id);
    const signature = createHash('sha256')
      .update(JSON.stringify({ ...row, turns: turns.get(threadId) ?? [] }))
      .digest('hex');
    result.set(threadId, {
      signature,
      itemCount: Number(row.count),
      updatedAtMs: Number(row.created) || 0,
    });
  }
  // Empty or interrupted turns still have a portable archive and a sync watermark.
  for (const [threadId, rows] of turns) {
    if (!result.has(threadId))
      result.set(threadId, {
        signature: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        itemCount: 0,
        updatedAtMs: Math.max(
          ...rows.map((row) => Number(row.completed_at ?? row.started_at ?? 0) * 1000)
        ),
      });
  }
  const realtimeColumns = new Set(
    history
      .prepare('PRAGMA table_info(thread_realtime_items)')
      .all()
      .map((row) => String(row.name))
  );
  if (
    ['thread_id', 'rollout_ordinal', 'created_at_ms'].every((name) => realtimeColumns.has(name))
  ) {
    const sql = `SELECT thread_id, COUNT(*) AS count, MAX(rollout_ordinal) AS ordinal, MAX(created_at_ms) AS created FROM thread_realtime_items ${id ? 'WHERE thread_id = ?' : ''} GROUP BY thread_id`;
    for (const row of id ? history.prepare(sql).all(id) : history.prepare(sql).all()) {
      const threadId = String(row.thread_id);
      const existing = result.get(threadId) ?? { signature: 'empty', itemCount: 0, updatedAtMs: 0 };
      result.set(threadId, {
        signature: createHash('sha256')
          .update(JSON.stringify([existing.signature, row]))
          .digest('hex'),
        itemCount: existing.itemCount + Number(row.count),
        updatedAtMs: Math.max(existing.updatedAtMs, Number(row.created) || 0),
      });
    }
  }
  return result;
}

function removedThreadMetadata(id: string, watermark: ThreadWatermark): SqlRow {
  return {
    id,
    title: `恢复归档 · ${id}`,
    cwd: '',
    archived: 1,
    updated: watermark.updatedAtMs,
    sourceRemoved: 1,
  };
}

/** New Codex versions migrate historical JSONL into a paginated SQLite projection. */
export async function hostSqliteThreads(home: string): Promise<HostSqliteThread[]> {
  const db = await openDatabases(home);
  if (!db) return [];
  try {
    db.history.exec('BEGIN');
    const watermarks = threadWatermarks(db.history);
    const columns = requireColumns(db.state, 'threads', [
      'id',
      'title',
      'cwd',
      'archived',
      'updated_at',
    ]);
    const updated = columns.has('updated_at_ms')
      ? 'COALESCE(updated_at_ms, updated_at * 1000)'
      : 'updated_at * 1000';
    const rows = db.state
      .prepare(
        `SELECT id, title, cwd, archived, ${updated} AS updated FROM threads ORDER BY updated_at, id`
      )
      .all();
    const known = new Set(rows.map((row) => String(row.id)));
    for (const [id, watermark] of watermarks)
      if (!known.has(id)) rows.push(removedThreadMetadata(id, watermark));
    return rows.map((row) => {
      const id = String(row.id);
      const watermark = watermarks.get(id) ?? { signature: 'empty', itemCount: 0 };
      return {
        id,
        title: String(row.title),
        cwd: String(row.cwd),
        archived: Boolean(row.archived),
        sourceUpdatedAt: iso(row.updated) ?? new Date(0).toISOString(),
        signature: createHash('sha256')
          .update(JSON.stringify([watermark.signature, row]))
          .digest('hex'),
        itemCount: watermark.itemCount,
        sourceRemoved: Boolean(row.sourceRemoved) || undefined,
      };
    });
  } finally {
    db.state.close();
    db.history.close();
  }
}

/**
 * Export one consistent read-only SQLite snapshot. Tool output is streamed to disk;
 * it is never concatenated into a JS string (individual histories can exceed 1 GB).
 * The caller supplies a private staging directory and removes the file after import.
 */
export async function exportHostSqliteThread(
  home: string,
  id: string,
  archivePath: string
): Promise<HostSqliteArchive | null> {
  const db = await openDatabases(home);
  if (!db) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    db.history.exec('BEGIN');
    const columns = requireColumns(db.state, 'threads', [
      'id',
      'title',
      'cwd',
      'archived',
      'updated_at',
    ]);
    const updated = columns.has('updated_at_ms')
      ? 'COALESCE(updated_at_ms, updated_at * 1000)'
      : 'updated_at * 1000';
    const watermarks = threadWatermarks(db.history, id);
    const metadata =
      db.state
        .prepare(`SELECT id, title, cwd, archived, ${updated} AS updated FROM threads WHERE id = ?`)
        .get(id) ??
      (watermarks.has(id) ? removedThreadMetadata(id, watermarks.get(id)!) : undefined);
    if (!metadata) return null;
    const watermark = watermarks.get(id) ?? {
      signature: 'empty',
      itemCount: 0,
    };
    const signature = createHash('sha256')
      .update(JSON.stringify([watermark.signature, metadata]))
      .digest('hex');
    const directory = await realpath(dirname(archivePath));
    const target = join(directory, basename(archivePath));
    file = await open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    let recordCount = 0;
    let pending = '';
    let pendingBytes = 0;
    const append = async (line: string) => {
      const bytes = Buffer.byteLength(line);
      hash.update(line);
      byteLength += bytes;
      recordCount++;
      pending += line;
      pendingBytes += bytes;
      if (pendingBytes >= 1024 * 1024) {
        await file!.writeFile(pending, 'utf8');
        pending = '';
        pendingBytes = 0;
      }
    };
    const cwd = String(metadata.cwd);
    const originalTitle = String(metadata.title ?? '');
    const sourceUpdatedAt = iso(metadata.updated) ?? new Date(0).toISOString();
    await append(
      `${JSON.stringify({ type: 'session_meta', timestamp: sourceUpdatedAt, payload: { id, title: originalTitle, cwd, archived: Boolean(metadata.archived), sourceRemoved: Boolean(metadata.sourceRemoved), historySource: 'codex-sqlite' } })}\n`
    );
    for (const row of db.history
      .prepare('SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal, turn_id')
      .iterate(id))
      await append(`${JSON.stringify({ type: 'thread_turn', payload: row })}\n`);
    const messages: string[] = [];
    let userTitle = '';
    let assistantTitle: string | undefined;
    const references: HostAttachmentReference[] = [];
    let firstEventAt: string | undefined;
    let lastEventAt: string | undefined;
    let malformedRecords = 0;
    const processItem = async (row: SqlRow, type: 'thread_item' | 'thread_realtime_item') => {
      const { item_json: rawValue, ...provenance } = row;
      const raw = String(rawValue);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        malformedRecords++;
        await append(`${JSON.stringify({ type, payloadRaw: raw, provenance })}\n`);
        return;
      }
      const timestamp = iso(row.created_at_ms);
      if (timestamp) {
        if (!firstEventAt || timestamp < firstEventAt) firstEventAt = timestamp;
        if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
      }
      // Embed item_json verbatim; no projection fields or tool results are discarded.
      await append(
        `{"type":${JSON.stringify(type)},"timestamp":${JSON.stringify(timestamp ?? '')},"provenance":${JSON.stringify(provenance)},"payload":${raw}}\n`
      );
      const role =
        payload.type === 'userMessage'
          ? 'user'
          : payload.type === 'agentMessage'
            ? 'assistant'
            : null;
      if (!role) return;
      const text = hostVisibleMessage(
        role === 'assistant' ? String(payload.text ?? '') : conversationText(payload.content)
      );
      if (role === 'user' && !userTitle) userTitle = hostConversationTitle(text);
      if (role === 'assistant' && !assistantTitle) assistantTitle = hostAssistantTitle(text, id);
      if (text) messages.push(`## ${role} · ${timestamp ?? ''}\n\n${text}`);
      const content = role === 'assistant' ? [{ type: 'output_text', text }] : payload.content;
      const line = JSON.stringify({
        type: 'response_item',
        timestamp,
        payload: { type: 'message', role, content },
      });
      for (const ref of hostAttachmentProvenance(line))
        references.push({ ...ref, sourceLine: recordCount, cwd });
    };
    const items = db.history
      .prepare(
        'SELECT * FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal, turn_id, item_id'
      )
      .iterate(id);
    const realtimeColumns = new Set(
      db.history
        .prepare('PRAGMA table_info(thread_realtime_items)')
        .all()
        .map((row) => String(row.name))
    );
    const realtime = [
      'thread_id',
      'item_id',
      'rollout_ordinal',
      'item_json',
      'created_at_ms',
    ].every((name) => realtimeColumns.has(name))
      ? db.history
          .prepare(
            'SELECT * FROM thread_realtime_items WHERE thread_id = ? ORDER BY rollout_ordinal, item_id'
          )
          .iterate(id)
      : undefined;
    // Merge cursors without loading tool payloads, preserving the original message timeline.
    let item = items.next();
    let live = realtime?.next();
    while (!item.done || (live && !live.done)) {
      if (
        live &&
        !live.done &&
        (item.done || Number(live.value.rollout_ordinal) < Number(item.value.rollout_ordinal))
      ) {
        await processItem(live.value, 'thread_realtime_item');
        live = realtime!.next();
      } else if (!item.done) {
        await processItem(item.value, 'thread_item');
        item = items.next();
      }
    }
    if (pending) await file.writeFile(pending, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    const sha256 = hash.digest('hex');
    const transcript = messages.join('\n\n');
    const title = !needsHostTitleRepair(originalTitle, id)
      ? originalTitle
      : userTitle ||
        assistantTitle ||
        `${metadata.sourceRemoved ? '恢复归档 ·' : 'Codex 会话'} ${id}`;
    return {
      source: {
        source: 'codex',
        sourceId: id,
        title,
        titleProjectionVersion: 1,
        kind: 'conversation',
        sourceUrl: `codex://threads/${id}`,
        sourceUpdatedAt,
        markdown: `# ${title}\n\n来源：Codex 会话 ${id}${metadata.sourceRemoved ? '（来源会话已移除，保留恢复归档）' : metadata.archived ? '（已归档）' : ''}\n\n${transcript || '该会话暂无可整理的用户或助手消息。完整原始记录仍保留在资料库中。'}`,
        sourceVersion: {
          kind: 'codex-sqlite',
          sha256,
          byteLength,
          recordCount,
          firstEventAt,
          lastEventAt,
          complete: malformedRecords === 0,
          malformedRecords,
          visibleMessages: messages.length,
          signature,
        },
        sessionCwd: cwd,
        sessionCwds: cwd ? [cwd] : [],
      },
      rawArchive: { path: target, sha256, byteLength },
      references,
    };
  } finally {
    await file?.close();
    db.state.close();
    db.history.close();
  }
}
