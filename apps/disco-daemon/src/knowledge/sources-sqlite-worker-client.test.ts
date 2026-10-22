import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportHostSqliteThread, hostSqliteThreads } from './sources-sqlite-worker-client';

describe('isolated Codex SQLite history worker', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-sqlite-worker-'));
    const state = new DatabaseSync(join(root, 'state_5.sqlite'));
    state.exec(
      "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER); INSERT INTO threads VALUES('thread','历史资料','',1,1700000000)"
    );
    state.close();
    const history = new DatabaseSync(join(root, 'thread_history_1.sqlite'));
    history.exec(
      'CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT); CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT)'
    );
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)')
      .run(
        'thread',
        'turn',
        'item',
        1,
        1_700_000_000_001,
        JSON.stringify({ type: 'agentMessage', text: 'COMPLETE MESSAGE\n'.repeat(100_000) })
      );
    history.close();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the full exported result over IPC while the main event loop keeps responding', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const catalog = await hostSqliteThreads(root);
      expect(catalog).toHaveLength(1);
      const result = (await exportHostSqliteThread(root, 'thread', join(root, 'export.jsonl')))!;
      expect(ticks).toBeGreaterThan(3);
      expect(result.source.markdown).toContain('COMPLETE MESSAGE\n'.repeat(100_000).trimEnd());
      expect(result.rawArchive.byteLength).toBe((await readFile(result.rawArchive.path)).length);
      expect(result.source.sourceVersion?.visibleMessages).toBe(1);
    } finally {
      clearInterval(timer);
    }
  });

  it('cancels a running child and releases its file handles before reporting AbortError', async () => {
    const controller = new AbortController();
    const exporting = exportHostSqliteThread(root, 'thread', join(root, 'cancelled.jsonl'), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    // Windows cannot remove an output file while the exporter still owns it.
    await rm(join(root, 'cancelled.jsonl'), { force: true });
  });

  it('preserves actionable schema errors from the child without executing arbitrary commands', async () => {
    const history = new DatabaseSync(join(root, 'thread_history_1.sqlite'));
    history.exec('DROP TABLE thread_items');
    history.close();
    await expect(hostSqliteThreads(root)).rejects.toThrow('结构暂不兼容');
  });
});
