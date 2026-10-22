import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportHostSqliteThread, hostSqliteThreads } from './sources-sqlite';

describe('Codex paginated SQLite history', () => {
  let root: string;
  let state: DatabaseSync;
  let history: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-sqlite-'));
    state = new DatabaseSync(join(root, 'state_5.sqlite'));
    history = new DatabaseSync(join(root, 'thread_history_1.sqlite'));
    state.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER, updated_at_ms INTEGER, creator_account_id TEXT)'
    );
    history.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id,item_id));
      CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE thread_realtime_items(thread_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_type TEXT, item_json TEXT);
    `);
    state
      .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)')
      .run(
        'parent',
        '真正的历史标题',
        root,
        1,
        1_700_000_000,
        1_700_000_000_001,
        'never-export-this-account-id'
      );
    state
      .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)')
      .run(
        'child',
        '子会话',
        root,
        0,
        1_700_000_001,
        1_700_000_001_001,
        'never-export-this-account-id'
      );
    history
      .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
      .run('parent', 'turn-a', 1, 'completed', 1_700_000_000, 1_700_000_001);
    const insert = history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)');
    insert.run(
      'parent',
      'turn-a',
      'user',
      2,
      1_700_000_000_010,
      JSON.stringify({
        type: 'userMessage',
        id: 'user',
        content: [
          { type: 'text', text: '第一行\n第二行' },
          { type: 'localImage', path: join(root, 'image.png') },
        ],
      }),
      'userMessage',
      2
    );
    insert.run(
      'parent',
      'turn-a',
      'tool',
      3,
      1_700_000_000_020,
      JSON.stringify({
        type: 'commandExecution',
        aggregatedOutput: 'FULL_TOOL_OUTPUT '.repeat(100_000),
      }),
      'commandExecution',
      3
    );
    insert.run(
      'parent',
      'turn-a',
      'agent',
      4,
      1_700_000_000_030,
      JSON.stringify({
        type: 'agentMessage',
        id: 'agent',
        text: '[交付文件](result.md)\n最后一行',
        phase: 'final',
      }),
      'agentMessage',
      4
    );
  });
  afterEach(async () => {
    state.close();
    history.close();
    await rm(root, { recursive: true, force: true });
  });

  it('includes archived and active history even when all legacy JSONL files have been migrated away', async () => {
    const threads = await hostSqliteThreads(root);
    expect(threads).toHaveLength(2);
    expect(threads.find((thread) => thread.id === 'parent')).toMatchObject({
      title: '真正的历史标题',
      archived: true,
      itemCount: 3,
    });
    expect(threads.find((thread) => thread.id === 'child')).toMatchObject({
      archived: false,
      itemCount: 0,
    });
    const before = threads.find((thread) => thread.id === 'parent')!.signature;
    history
      .prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=9 WHERE item_id=?')
      .run(JSON.stringify({ type: 'agentMessage', text: '持续输出的新内容' }), 'agent');
    expect(
      (await hostSqliteThreads(root)).find((thread) => thread.id === 'parent')!.signature
    ).not.toBe(before);
  });

  it('streams complete original rows and returns readable messages plus attachment provenance without credentials', async () => {
    await writeFile(join(root, 'auth.json'), 'DO_NOT_READ');
    const path = join(root, 'archive.jsonl');
    const catalog = await hostSqliteThreads(root);
    const result = (await exportHostSqliteThread(root, 'parent', path))!;
    expect(result.source.sourceId).toBe('parent');
    expect(result.source.title).toBe('真正的历史标题');
    expect(result.source.rawContent).toBeUndefined();
    expect(result.source.markdown).toContain('第一行\n第二行');
    expect(result.source.markdown).toContain('最后一行');
    expect(result.source.markdown).not.toContain('FULL_TOOL_OUTPUT');
    expect(result.source.sourceVersion?.signature).toBe(
      catalog.find((thread) => thread.id === 'parent')!.signature
    );
    expect(result.source.sourceVersion).toMatchObject({
      kind: 'codex-sqlite',
      complete: true,
      recordCount: 5,
    });
    const bytes = await readFile(path);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    expect(result.rawArchive.byteLength).toBe(bytes.length);
    expect(result.rawArchive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const raw = bytes.toString('utf8');
    expect(raw).not.toContain('DO_NOT_READ');
    expect(raw).not.toContain('never-export-this-account-id');
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      rows.find((row) => row.payload.type === 'commandExecution').payload.aggregatedOutput
    ).toBe('FULL_TOOL_OUTPUT '.repeat(100_000));
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: 'result.md', role: 'assistant', cwd: root }),
        expect.objectContaining({ reference: join(root, 'image.png'), role: 'user', cwd: root }),
      ])
    );
    expect(
      state.prepare('SELECT creator_account_id FROM threads WHERE id=?').get('parent')
        ?.creator_account_id
    ).toBe('never-export-this-account-id');
  });

  it('does not replace staging files and binds thread IDs rather than interpolating SQL', async () => {
    const path = join(root, 'keep.jsonl');
    await writeFile(path, 'KEEP');
    await expect(exportHostSqliteThread(root, 'parent', path)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path, 'utf8')).toBe('KEEP');
    expect(
      await exportHostSqliteThread(root, "parent' OR 1=1 --", join(root, 'none.jsonl'))
    ).toBeNull();
    expect(state.prepare('SELECT COUNT(*) AS count FROM threads').get()?.count).toBe(2);
  });

  it('retains orphaned history as an explicitly labeled recovery archive and counts empty conversations', async () => {
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        'orphan',
        'removed-turn',
        'message',
        1,
        1_700_000_000_010,
        JSON.stringify({ type: 'agentMessage', text: '可恢复的历史内容' }),
        'agentMessage',
        1
      );
    const catalog = await hostSqliteThreads(root);
    expect(catalog).toHaveLength(3);
    expect(catalog.find((thread) => thread.id === 'orphan')).toMatchObject({
      sourceRemoved: true,
      archived: true,
      itemCount: 1,
    });
    const recovered = (await exportHostSqliteThread(
      root,
      'orphan',
      join(root, 'recovered.jsonl')
    ))!;
    expect(recovered.source.markdown).toContain('来源会话已移除');
    expect(recovered.source.markdown).toContain('可恢复的历史内容');
    expect(recovered.source.sourceVersion?.visibleMessages).toBe(1);
    expect(recovered.source.sourceVersion?.signature).toBe(
      catalog.find((thread) => thread.id === 'orphan')!.signature
    );
    const empty = (await exportHostSqliteThread(root, 'child', join(root, 'empty.jsonl')))!;
    expect(empty.source.sourceVersion?.visibleMessages).toBe(0);
    expect(empty.source.markdown).toContain('暂无可整理');
  });

  it('includes realtime message changes in the incremental watermark and filters app-injected context', async () => {
    const before = (await hostSqliteThreads(root)).find(
      (thread) => thread.id === 'parent'
    )!.signature;
    history
      .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?,?)')
      .run(
        'parent',
        'live',
        10,
        1_700_000_000_100,
        'agentMessage',
        JSON.stringify({ type: 'agentMessage', text: '实时对话内容' })
      );
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      'parent',
      'turn-a',
      'context',
      11,
      1_700_000_000_110,
      JSON.stringify({
        type: 'userMessage',
        content: [
          { type: 'text', text: '<environment_context>INJECTED_CONTEXT</environment_context>' },
        ],
      }),
      'userMessage',
      11
    );
    const after = (await hostSqliteThreads(root)).find(
      (thread) => thread.id === 'parent'
    )!.signature;
    expect(after).not.toBe(before);
    const result = (await exportHostSqliteThread(root, 'parent', join(root, 'realtime.jsonl')))!;
    expect(result.source.sourceVersion?.signature).toBe(after);
    expect(result.source.sourceVersion?.visibleMessages).toBe(3);
    expect(result.source.markdown).toContain('实时对话内容');
    expect(result.source.markdown).not.toContain('INJECTED_CONTEXT');
    expect(await readFile(result.rawArchive.path, 'utf8')).toContain('INJECTED_CONTEXT');
  });

  it('reports unsupported schemas rather than silently claiming an empty complete archive', async () => {
    history.exec('ALTER TABLE thread_items RENAME COLUMN item_json TO changed_payload');
    await expect(hostSqliteThreads(root)).rejects.toThrow('结构暂不兼容');
  });

  it('keeps one consistent history snapshot while Codex appends another answer in WAL mode', async () => {
    const insert = history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 5; i++)
      insert.run(
        'parent',
        'turn-a',
        `large-tool-${i}`,
        5 + i,
        1_700_000_000_040 + i,
        JSON.stringify({
          type: 'commandExecution',
          aggregatedOutput: 'complete output'.repeat(100_000),
        }),
        'commandExecution',
        5 + i
      );
    const path = join(root, 'snapshot.jsonl');
    const exporting = exportHostSqliteThread(root, 'parent', path);
    while (!(await stat(path).catch(() => null))?.size)
      await new Promise<void>((resolve) => setImmediate(resolve));
    insert.run(
      'parent',
      'turn-a',
      'next-answer',
      20,
      1_700_000_000_099,
      JSON.stringify({ type: 'agentMessage', text: 'APPENDED_AFTER_SNAPSHOT' }),
      'agentMessage',
      20
    );
    const result = (await exporting)!;
    expect(result.source.markdown).not.toContain('APPENDED_AFTER_SNAPSHOT');
    expect(await readFile(path, 'utf8')).not.toContain('APPENDED_AFTER_SNAPSHOT');
    const next = (await exportHostSqliteThread(root, 'parent', join(root, 'next.jsonl')))!;
    expect(next.source.markdown).toContain('APPENDED_AFTER_SNAPSHOT');
    expect(next.source.sourceVersion?.signature).not.toBe(result.source.sourceVersion?.signature);
  });

  it('does not follow a database symlink outside the configured home', async () => {
    const outside = join(root, 'private');
    const otherHome = join(root, 'other');
    await mkdir(outside);
    await mkdir(otherHome);
    await symlink(
      outside,
      join(otherHome, 'state_5.sqlite'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await symlink(
      outside,
      join(otherHome, 'thread_history_1.sqlite'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(hostSqliteThreads(otherHome)).rejects.toThrow('普通文件');
  });
});
