import type { KnowledgeEntryDetail, KnowledgeLibraryStatus } from '@disco/core/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonProps } from 'antd';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from './KnowledgePage';
import { knowledgeApi } from './knowledgeApi';

// jsdom's cssstyle cannot parse AntD 6 button border variables. Preserve native
// button/link semantics here; browser QA covers the actual themed components.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Button: ({
      children,
      disabled,
      loading,
      onClick,
      href,
      style,
      'aria-label': label,
    }: ButtonProps) =>
      href ? (
        <a href={href} style={style} aria-label={label}>
          {children}
        </a>
      ) : (
        <button
          type="button"
          disabled={disabled || Boolean(loading)}
          onClick={onClick}
          style={style}
          aria-label={label}
        >
          {children}
        </button>
      ),
  };
});

vi.mock('./knowledgeApi', () => ({
  knowledgeApi: {
    catalog: vi.fn(),
    organize: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    uploadDocument: vi.fn(),
    exportLibrary: vi.fn(),
    downloadAttachment: vi.fn(),
    downloadMarkdown: vi.fn(),
  },
}));

const DETAIL: KnowledgeEntryDetail = {
  entry: {
    id: 'entry-a',
    title: '产品讨论',
    kind: 'conversation',
    source: 'disco',
    sourceId: 'session-a',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    humanEdited: false,
    relativePath: 'conversations/entry-a.md',
    sizeBytes: 50,
    indexStatus: 'indexed',
    sourceUrl: '/s/session-a/',
    attachments: [{ id: 'attachment-a', name: '原始附件.pdf' }],
  },
  markdown: '# 原始记录\n![图片](https://example.com/private-image.png)\n<script>alert(1)</script>',
  contentHash: 'hash-a',
};
const STATUS: KnowledgeLibraryStatus = {
  total: 1,
  conversations: 1,
  notes: 0,
  documents: 0,
  humanEdited: 0,
  pendingIndex: 0,
  deleted: 0,
  totalBytes: 50,
  sync: { state: 'idle' },
  engine: { status: 'ready' },
};

const CATALOG = {
  entries: [DETAIL.entry],
  total: 1,
  status: STATUS,
  overview: {
    counts: { source: 1, summary: 0, knowledge: 0 },
    materials: { conversation: 1, document: 0, image: 0, file: 0, note: 0 },
    topics: [{ topic: '产品设计', count: 1 }],
  },
};

function renderPage(entryId?: string) {
  return render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <AntApp>
        <KnowledgePage mobile entryId={entryId} onGoHome={vi.fn()} />
      </AntApp>
    </ConfigProvider>
  );
}

describe('knowledge library management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(knowledgeApi.catalog).mockResolvedValue(CATALOG);
    vi.mocked(knowledgeApi.detail).mockResolvedValue(DETAIL);
    vi.mocked(knowledgeApi.remove).mockResolvedValue(undefined);
  });

  it('loads only metadata until a record is opened and keeps imported HTML and images inert', async () => {
    renderPage();
    const entry = await screen.findByRole('button', { name: '产品讨论' });
    expect(knowledgeApi.detail).not.toHaveBeenCalled();
    expect(knowledgeApi.downloadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /刷新/ })).not.toBeInTheDocument();
    fireEvent.click(entry);
    expect(await screen.findByText(/原始记录/)).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenCalledWith('entry-a', expect.any(AbortSignal), {
      offset: 0,
      limit: 40_000,
    });
    expect(document.querySelector('img[src*="private-image"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('link', { name: '查看原始出处' })).toHaveAttribute(
      'href',
      '/s/session-a/'
    );
    expect(knowledgeApi.downloadAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '原始附件.pdf' }));
    await waitFor(() =>
      expect(knowledgeApi.downloadAttachment).toHaveBeenCalledWith(
        'entry-a',
        'attachment-a',
        '原始附件.pdf'
      )
    );
  });

  it('opens a linked entry even when that record is not in the current list page', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [], total: 0 });
    renderPage('entry-a');
    expect(await screen.findByText(/原始记录/)).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenCalledWith('entry-a', expect.any(AbortSignal), {
      offset: 0,
      limit: 40_000,
    });
    expect(knowledgeApi.downloadAttachment).not.toHaveBeenCalled();
  });

  it('distinguishes retained originals from unsupported or failed text extraction', async () => {
    vi.mocked(knowledgeApi.uploadDocument)
      .mockResolvedValueOnce({ ...DETAIL, parsing: { status: 'unsupported' } })
      .mockResolvedValueOnce({ ...DETAIL, parsing: { status: 'error' } });
    const { container } = renderPage();
    const chooser = container.querySelector('input[type="file"]');
    if (!chooser) throw new Error('Expected file chooser');
    fireEvent.change(chooser, {
      target: {
        files: [new File(['binary'], '设计稿.psd'), new File(['broken'], '损坏文档.pdf')],
      },
    });
    expect(await screen.findByText('原件已保留，请留意正文解析状态')).toBeInTheDocument();
    expect(
      screen.getByText(/设计稿.psd：暂不支持解析此格式，正文尚不能检索。/)
    ).toBeInTheDocument();
    expect(screen.getByText(/损坏文档.pdf：正文解析失败，原件仍可下载。/)).toBeInTheDocument();
    expect(await screen.findByText('已保存 2 份原件')).toBeInTheDocument();
    expect(screen.queryByText(/索引将在后台更新/)).not.toBeInTheDocument();
    expect(knowledgeApi.uploadDocument).toHaveBeenCalledTimes(2);
  });

  it('keeps a persisted parsing failure visible after reopening a retained document', async () => {
    const detail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        kind: 'document' as const,
        parseStatus: 'error' as const,
        parseMessage: '解析器暂不可用，后台将重试。',
      },
    };
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({
      ...CATALOG,
      entries: [detail.entry],
      total: 1,
    });
    vi.mocked(knowledgeApi.detail).mockResolvedValue(detail);
    renderPage();
    expect(await screen.findByText('正文解析失败 · 原件已保留')).toBeInTheDocument();
    expect(screen.getByText('仅文件信息可检索')).toBeInTheDocument();
    expect(screen.queryByText('已索引')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '产品讨论' }));
    expect(await screen.findByText('解析器暂不可用，后台将重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '原始附件.pdf' })).toBeEnabled();
    expect(knowledgeApi.downloadAttachment).not.toHaveBeenCalled();
  });

  it('keeps an edited draft on conflict and sends the version that was opened', async () => {
    vi.mocked(knowledgeApi.save).mockRejectedValue(new Error('这份资料已有新修改'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '我的人工修改' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('这份资料已有新修改')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toHaveValue('我的人工修改');
    expect(knowledgeApi.save).toHaveBeenCalledWith(
      'entry-a',
      '产品讨论',
      '我的人工修改',
      DETAIL.entry.updatedAt,
      expect.objectContaining({ level: 'source' })
    );
    fireEvent.focus(window);
    await waitFor(() => expect(knowledgeApi.catalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toHaveValue('我的人工修改');
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toHaveStyle({
      fontSize: '16px',
    });
  });

  it('shows deletion scope before deleting and waits for the server result', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '删除 产品讨论' }));
    expect(await screen.findByText('后续自动同步不会重新导入这份记录。')).toBeInTheDocument();
    expect(screen.getByText(/原会话和原始资料不受影响/)).toBeInTheDocument();
    expect(knowledgeApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除知识库记录' }));
    await waitFor(() => expect(knowledgeApi.remove).toHaveBeenCalledWith('entry-a'));
    expect(await screen.findByText('已从知识库删除')).toBeInTheDocument();
  });

  it('creates a note once and then edits that saved note instead of creating duplicates', async () => {
    const note = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        id: 'note-a',
        title: '新笔记',
        source: 'manual' as const,
        kind: 'note' as const,
        humanEdited: true,
      },
      markdown: '正文',
    };
    vi.mocked(knowledgeApi.create).mockResolvedValue(note);
    vi.mocked(knowledgeApi.detail).mockResolvedValue(note);
    vi.mocked(knowledgeApi.save).mockResolvedValue({ ...note, markdown: '补充正文' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
    fireEvent.change(screen.getByRole('textbox', { name: '资料标题' }), {
      target: { value: '新笔记' },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '补充正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'note-a',
        '新笔记',
        '补充正文',
        note.entry.updatedAt,
        expect.objectContaining({ level: 'knowledge' })
      )
    );
    expect(knowledgeApi.create).toHaveBeenCalledTimes(1);
  });

  it('opens in knowledge notes and keeps original material type filters separate from note levels', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [], total: 0 });
    renderPage();
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        kind: 'note',
      })
    );
    expect(screen.getByRole('combobox', { name: '知识层级' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '资料类型' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '查看原始资料' }));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        level: 'source',
        includeHistory: false,
      })
    );
    expect(screen.queryByRole('combobox', { name: '知识层级' })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '资料类型' }));
    fireEvent.click(
      await screen.findByText('图片', { selector: '.ant-select-item-option-content' })
    );
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        level: 'source',
        materialType: 'image',
        includeHistory: false,
      })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '包含修复前的历史副本' }));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        level: 'source',
        materialType: 'image',
        includeHistory: true,
      })
    );
    expect(knowledgeApi.detail).not.toHaveBeenCalled();
  });

  it('keeps selection across pages and creates a source-linked manual note for editing', async () => {
    const second = { ...DETAIL.entry, id: 'entry-b', title: '技术决策' };
    const manual: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        id: 'note-manual',
        title: '产品结论',
        kind: 'note',
        source: 'manual',
        humanEdited: true,
        organization: {
          topic: '产品设计',
          level: 'knowledge',
          state: 'draft',
          sourceEntryIds: ['entry-a', 'entry-b'],
        },
      },
      markdown: '# 产品结论\n\n## 我的总结\n',
      sources: [
        { id: 'entry-a', title: '产品讨论', available: true },
        { id: 'entry-b', title: '技术决策', available: true },
      ],
    };
    vi.mocked(knowledgeApi.catalog).mockImplementation(async (_query, _source, offset) => ({
      ...CATALOG,
      entries: [offset ? second : DETAIL.entry],
      total: 21,
    }));
    vi.mocked(knowledgeApi.organize).mockResolvedValue(manual);
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.click(screen.getByTitle('2'));
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 技术决策' }));
    expect(screen.getByText('已选 2 份')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '人工整理' }));
    fireEvent.change(screen.getByRole('textbox', { name: '整理笔记标题' }), {
      target: { value: '产品结论' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '整理笔记主题' }), {
      target: { value: '产品设计' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建并编辑' }));
    expect(await screen.findByRole('textbox', { name: 'Markdown 正文' })).toHaveValue(
      manual.markdown
    );
    expect(knowledgeApi.organize).toHaveBeenCalledWith({
      entryIds: ['entry-a', 'entry-b'],
      title: '产品结论',
      topic: '产品设计',
      mode: 'manual',
    });
    expect(screen.getByRole('link', { name: '技术决策' })).toHaveAttribute(
      'href',
      '/knowledge?entry=entry-b'
    );
    expect(screen.getByText('来源在新页面打开，当前编辑内容会保留。')).toBeInTheDocument();
    expect(knowledgeApi.detail).not.toHaveBeenCalled();
    expect(knowledgeApi.downloadAttachment).not.toHaveBeenCalled();
  });

  it('never replaces a human draft with a late automatic-generation response', async () => {
    const queued: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        id: 'note-auto',
        title: '自动整理草稿',
        kind: 'note',
        generation: { state: 'queued' },
        organization: { topic: '产品设计', level: 'knowledge', state: 'draft' },
      },
      markdown: '等待整理',
    };
    let resolvePending: ((value: KnowledgeEntryDetail) => void) | undefined;
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce(queued)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          })
      )
      .mockResolvedValue(queued);
    renderPage('note-auto');
    expect(await screen.findByText('等待整理')).toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(knowledgeApi.detail).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '我正在写的结论' },
    });
    await act(async () =>
      resolvePending?.({
        ...queued,
        markdown: '后台生成的结论',
        entry: { ...queued.entry, generation: { state: 'complete' } },
      })
    );
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toHaveValue('我正在写的结论');
    fireEvent(document, new Event('visibilitychange'));
    expect(knowledgeApi.detail).toHaveBeenCalledTimes(3);
  });

  it('queues automatic organization and shows the generated note without a manual refresh', async () => {
    const queued: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        id: 'automatic-note',
        title: '设计结论',
        kind: 'note',
        generation: { state: 'queued' },
        organization: { topic: '产品设计', level: 'knowledge', state: 'draft' },
      },
      markdown: '后台正在整理这份资料',
    };
    const completed: KnowledgeEntryDetail = {
      ...queued,
      entry: { ...queued.entry, generation: { state: 'complete' } },
      markdown: '## 已确认的设计方向\n\n- 移动端不额外增加高度\n- 保留原始资料出处',
    };
    vi.mocked(knowledgeApi.organize).mockResolvedValue(queued);
    vi.mocked(knowledgeApi.detail).mockResolvedValueOnce(queued).mockResolvedValue(completed);
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.click(screen.getByRole('button', { name: '自动整理所选' }));
    fireEvent.click(screen.getByRole('button', { name: '加入整理队列' }));
    expect(await screen.findByText('后台正在整理这份资料')).toBeInTheDocument();
    expect(knowledgeApi.organize).toHaveBeenCalledWith({
      entryIds: ['entry-a'],
      mode: 'automatic',
      title: undefined,
      topic: undefined,
    });
    expect(screen.queryByRole('button', { name: '确认并人工维护' })).not.toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByRole('heading', { name: '已确认的设计方向' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认并人工维护' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Markdown 正文' })).not.toBeInTheDocument();
  });

  it('shows independent failures and confirms a generated note without changing its source links', async () => {
    const generated: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        kind: 'note',
        generation: { state: 'complete' },
        organization: {
          topic: '产品设计',
          level: 'summary',
          state: 'draft',
          sourceEntryIds: ['source-a'],
        },
        indexStatus: 'error',
        indexMessage: '嵌入服务暂不可用',
      },
      sources: [{ id: 'source-a', title: '原会话', available: true }],
    };
    vi.mocked(knowledgeApi.detail).mockResolvedValue(generated);
    vi.mocked(knowledgeApi.save).mockResolvedValue({
      ...generated,
      entry: {
        ...generated.entry,
        humanEdited: true,
        organization: { ...generated.entry.organization!, state: 'reviewed' },
      },
    });
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({
      ...CATALOG,
      status: {
        ...STATUS,
        total: 17,
        conversations: 8,
        documents: 4,
        notes: 5,
        sync: { state: 'running', intervalSeconds: 30 },
        processing: {
          index: { pending: 5, indexed: 10, failed: 2, unsupported: 3 },
          summary: { pending: 4, completed: 2, failed: 1 },
        },
      },
    });
    renderPage('entry-a');
    expect(await screen.findByText('嵌入服务暂不可用')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /后台处理/ }));
    expect(screen.getByText('检索索引 · 10 / 17')).toBeInTheDocument();
    expect(screen.getByText('原始归档 · 12 份已保留')).toBeInTheDocument();
    expect(screen.getByText(/每轮完成后 30 秒再次检查/)).toBeInTheDocument();
    expect(screen.getByText(/其中 3 份仅文件信息/)).toBeInTheDocument();
    expect(screen.getByText(/2 份失败，后台重试/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认并人工维护' }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'entry-a',
        generated.entry.title,
        generated.markdown,
        generated.entry.updatedAt,
        { topic: '产品设计', level: 'summary', state: 'reviewed', sourceEntryIds: ['source-a'] }
      )
    );
    expect(await screen.findByText('已确认，由你维护，自动整理不会覆盖')).toBeInTheDocument();
  });

  it('reads long originals in bounded segments and loads the complete body before editing', async () => {
    const firstText = '第一段开头'.padEnd(40_000, '文');
    const fullText = `${firstText}最后一段原文`;
    const complete = { ...DETAIL, markdown: fullText };
    vi.mocked(knowledgeApi.detail).mockImplementation(async (_id, _signal, page) => {
      if (!page) return complete;
      return {
        ...complete,
        markdown: page.offset ? '最后一段原文' : firstText,
        page: {
          offset: page.offset,
          totalChars: fullText.length,
          nextOffset: page.offset ? null : 40_000,
          hasMore: page.offset === 0,
        },
      };
    });
    vi.mocked(knowledgeApi.save).mockResolvedValue({
      ...complete,
      markdown: `${fullText}\n人工补充`,
    });
    renderPage('entry-a');
    const next = await screen.findByRole('button', { name: '下一段' });
    expect(screen.queryByText('最后一段原文', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(next);
    expect(await screen.findByText('最后一段原文', { exact: true })).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', undefined, {
      offset: 40_000,
      limit: 40_000,
      contentHash: DETAIL.contentHash,
    });
    expect(screen.queryByText(/^第一段开头/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' });
    expect(editor).toHaveValue(fullText);
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a');
    fireEvent.change(editor, { target: { value: `${fullText}\n人工补充` } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'entry-a',
        '产品讨论',
        `${fullText}\n人工补充`,
        DETAIL.entry.updatedAt,
        expect.any(Object)
      )
    );
    expect(await screen.findByRole('button', { name: '下一段' })).toBeInTheDocument();
    expect(screen.queryByText(/人工补充/)).not.toBeInTheDocument();
  });

  it('keeps the readable segment and offers no partial editor when the complete load fails', async () => {
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce({
        ...DETAIL,
        markdown: '可阅读的第一段',
        page: { offset: 0, totalChars: 100_000, nextOffset: 40_000, hasMore: true },
      })
      .mockRejectedValueOnce(new Error('完整原文暂时不可用'));
    renderPage('entry-a');
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect(await screen.findByText('完整原文暂时不可用')).toBeInTheDocument();
    expect(screen.getByText('可阅读的第一段')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Markdown 正文' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
    expect(knowledgeApi.save).not.toHaveBeenCalled();
  });

  it('rejects a changed version during paging while retaining the existing segment', async () => {
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce({
        ...DETAIL,
        markdown: '阅读中的原文',
        page: { offset: 0, totalChars: 100_000, nextOffset: 40_000, hasMore: true },
      })
      .mockRejectedValueOnce(new Error('这份资料已有新修改，请重新打开。'));
    renderPage('entry-a');
    fireEvent.click(await screen.findByRole('button', { name: '下一段' }));
    expect(await screen.findByText('这份资料已有新修改，请重新打开。')).toBeInTheDocument();
    expect(screen.getByText('阅读中的原文')).toBeInTheDocument();
    expect(knowledgeApi.save).not.toHaveBeenCalled();
  });

  it('returns to the actual prior segment boundary after emoji-safe offsets', async () => {
    vi.mocked(knowledgeApi.detail).mockImplementation(async (_id, _signal, page) => {
      const offset = page?.offset ?? 0;
      return {
        ...DETAIL,
        markdown: offset === 0 ? '第一段' : offset === 39_999 ? '第二段🙂' : '第三段🙂',
        page: {
          offset,
          totalChars: 90_000,
          nextOffset: offset === 0 ? 39_999 : offset === 39_999 ? 79_998 : null,
          hasMore: offset !== 79_998,
        },
      };
    });
    renderPage('entry-a');
    fireEvent.click(await screen.findByRole('button', { name: '下一段' }));
    expect(await screen.findByText('第二段🙂')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一段' }));
    expect(await screen.findByText('第三段🙂')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上一段' }));
    expect(await screen.findByText('第二段🙂')).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', undefined, {
      offset: 39_999,
      limit: 40_000,
      contentHash: DETAIL.contentHash,
    });
  });

  it('confirms a long draft using its full content and refuses a newer unseen version', async () => {
    const complete: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        kind: 'note',
        organization: { topic: '软件', level: 'knowledge', state: 'draft' },
      },
      markdown: '第一段\n中间内容\n最后一段',
    };
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce({
        ...complete,
        markdown: '第一段',
        page: { offset: 0, totalChars: 18, nextOffset: 4, hasMore: true },
      })
      .mockResolvedValueOnce({ ...complete, contentHash: 'new-version' })
      .mockResolvedValue(complete);
    vi.mocked(knowledgeApi.save).mockResolvedValue({
      ...complete,
      entry: {
        ...complete.entry,
        humanEdited: true,
        organization: { ...complete.entry.organization!, state: 'reviewed' },
      },
    });
    renderPage('entry-a');
    fireEvent.click(await screen.findByRole('button', { name: '确认并人工维护' }));
    expect(
      await screen.findByText('这份资料已有新修改，请重新打开并阅读最新内容后再确认。')
    ).toBeInTheDocument();
    expect(knowledgeApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并人工维护' }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'entry-a',
        '产品讨论',
        complete.markdown,
        complete.entry.updatedAt,
        expect.objectContaining({ state: 'reviewed' })
      )
    );
  });
});
