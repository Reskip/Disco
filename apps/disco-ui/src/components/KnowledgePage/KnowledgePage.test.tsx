import type { KnowledgeEntryDetail, KnowledgeLibraryStatus } from '@disco/core/types';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      target,
      style,
      'aria-label': label,
      'aria-pressed': pressed,
    }: ButtonProps) =>
      href ? (
        <a href={href} target={target} style={style} aria-label={label}>
          {children}
        </a>
      ) : (
        <button
          type="button"
          disabled={disabled || Boolean(loading)}
          onClick={onClick}
          style={style}
          aria-label={label}
          aria-pressed={pressed}
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
    expect(
      screen
        .getByRole('button', { name: '原始附件.pdf' })
        .compareDocumentPosition(screen.getByText(/原始记录/)) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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

  it('opens imported originals from the upload feedback and preserves existing selections', async () => {
    vi.mocked(knowledgeApi.uploadDocument).mockResolvedValue({
      ...DETAIL,
      parsing: { status: 'parsed' },
    });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '产品' },
    });
    const chooser = container.querySelector('input[type="file"]');
    if (!chooser) throw new Error('Expected file chooser');
    fireEvent.change(chooser, { target: { files: [new File(['# 资料'], '资料.md')] } });
    expect(await screen.findByText('已导入 1 份原件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看原始资料' }));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        level: 'source',
        includeHistory: false,
      })
    );
    expect(screen.getByRole('radio', { name: '原始资料 1' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: '搜索知识库' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: '选择 产品讨论' })).toBeChecked();
    expect(screen.queryByText('已导入 1 份原件')).not.toBeInTheDocument();
  });

  it('dismisses a parsing notice without removing the uploaded original', async () => {
    vi.mocked(knowledgeApi.uploadDocument).mockResolvedValue({
      ...DETAIL,
      parsing: { status: 'unsupported' },
    });
    const { container } = renderPage();
    const chooser = container.querySelector('input[type="file"]');
    if (!chooser) throw new Error('Expected file chooser');
    fireEvent.change(chooser, { target: { files: [new File(['binary'], '资料.custom')] } });
    const notice = await screen.findByText('原件已保留，请留意正文解析状态');
    const alert = notice.closest('.ant-alert');
    if (!alert) throw new Error('Expected upload notice');
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: '关闭导入提示' }));
    expect(screen.queryByText('原件已保留，请留意正文解析状态')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '产品讨论' })).toBeInTheDocument();
    expect(knowledgeApi.remove).not.toHaveBeenCalled();
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
        sort: 'curated',
      })
    );
    expect(screen.getByRole('group', { name: '笔记分类' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '资料类型' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '查看原始资料' }));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        level: 'source',
        includeHistory: false,
      })
    );
    expect(screen.queryByRole('group', { name: '笔记分类' })).not.toBeInTheDocument();
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

  it('filters note categories on the server, resets pagination and retains selected sources', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, total: 21 });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith(
        '',
        'all',
        20,
        expect.any(AbortSignal),
        { kind: 'note', sort: 'curated' }
      )
    );
    for (const [label, noteType] of [
      ['专题知识', 'knowledge'],
      ['摘要', 'summary'],
      ['资料概览', 'overview'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
      await waitFor(() =>
        expect(knowledgeApi.catalog).toHaveBeenLastCalledWith(
          '',
          'all',
          0,
          expect.any(AbortSignal),
          { kind: 'note', sort: 'curated', noteType }
        )
      );
      expect(screen.getByText('已选 1 份')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    }
    fireEvent.click(screen.getByRole('button', { name: '全部笔记', exact: true }));
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
        kind: 'note',
        sort: 'curated',
      })
    );
  });

  it('offers note topics without raw-archive-only categories in the note view', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({
      ...CATALOG,
      overview: {
        ...CATALOG.overview,
        topics: [
          { topic: '未分类原件', count: 100 },
          { topic: '产品设计', count: 2 },
        ],
        noteTopics: [{ topic: '产品设计', count: 2 }],
      },
    });
    renderPage();
    await screen.findByRole('button', { name: '产品讨论' });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '知识主题' }));
    expect(
      await screen.findByText('产品设计 (2)', { selector: '.ant-select-item-option-content' })
    ).toBeInTheDocument();
    expect(screen.queryByText('未分类原件 (100)')).not.toBeInTheDocument();
  });

  it('opens each processing issue in its matching view without losing selected sources', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({
      ...CATALOG,
      overview: {
        ...CATALOG.overview,
        issues: {
          sources: { indexErrors: 1, parseErrors: 2, metadataOnly: 5, summaryErrors: 3 },
          notes: { indexErrors: 1, summaryErrors: 2 },
        },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '临时筛选' },
    });
    fireEvent.click(screen.getByRole('button', { name: /后台处理/ }));
    for (const [label, processing, view] of [
      ['2 份正文解析失败', 'parse_error', 'sources'],
      ['其中 5 份仅文件信息', 'metadata_only', 'sources'],
      ['原始资料 1 份索引失败', 'index_error', 'sources'],
      ['原始资料 3 份整理失败', 'summary_error', 'sources'],
      ['笔记 1 篇索引失败', 'index_error', 'notes'],
      ['笔记 2 篇整理失败', 'summary_error', 'notes'],
    ]) {
      fireEvent.click(await screen.findByRole('button', { name: label, exact: true }));
      await waitFor(() =>
        expect(knowledgeApi.catalog).toHaveBeenLastCalledWith(
          '',
          'all',
          0,
          expect.any(AbortSignal),
          view === 'sources'
            ? { level: 'source', includeHistory: false, processing }
            : { kind: 'note', sort: 'curated', processing }
        )
      );
      expect(screen.getByText('已选 1 份')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: '搜索知识库' })).toHaveValue('');
    }
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '处理状态' }));
    expect(
      screen.queryByText('正文解析失败', { selector: '.ant-select-item-option-content' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('仅文件信息可检索', { selector: '.ant-select-item-option-content' })
    ).not.toBeInTheDocument();
  });

  it('shows matching content during search instead of hiding it behind a general summary', async () => {
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({
      ...CATALOG,
      entries: [
        {
          ...DETAIL.entry,
          snippet: '命中片段：索引分批重试的具体步骤。',
          organization: {
            topic: '产品设计',
            level: 'summary',
            state: 'draft',
            summary: '一般性资料概述',
          },
        },
      ],
    });
    renderPage();
    expect(await screen.findByText('一般性资料概述')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '索引 重试' },
    });
    expect(await screen.findByText('命中片段：索引分批重试的具体步骤。')).toBeInTheDocument();
    expect(screen.queryByText('一般性资料概述')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '' },
    });
    expect(await screen.findByText('一般性资料概述')).toBeInTheDocument();
  });

  it('recovers from an empty filtered search without changing the source view or selected records', async () => {
    vi.mocked(knowledgeApi.catalog).mockImplementation(
      async (query, _source, _offset, _signal, filters) => ({
        ...CATALOG,
        entries: query || filters?.materialType ? [] : [DETAIL.entry],
        total: query || filters?.materialType ? 0 : 1,
      })
    );
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.click(screen.getByRole('radio', { name: '原始资料 1' }));
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '资料类型' }));
    fireEvent.click(
      await screen.findByText('图片', { selector: '.ant-select-item-option-content' })
    );
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '不存在的资料' },
    });
    await waitFor(() =>
      expect(knowledgeApi.catalog).toHaveBeenLastCalledWith(
        '不存在的资料',
        'all',
        0,
        expect.any(AbortSignal),
        expect.objectContaining({ materialType: 'image' })
      )
    );
    expect(await screen.findByText('没有找到匹配的资料')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByRole('button', { name: '产品讨论' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜索知识库' })).toHaveValue('');
    expect(screen.getByRole('radio', { name: '原始资料 1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 产品讨论' })).toBeChecked();
    expect(screen.getByText('已选 1 份')).toBeInTheDocument();
    expect(knowledgeApi.catalog).toHaveBeenLastCalledWith('', 'all', 0, expect.any(AbortSignal), {
      level: 'source',
      includeHistory: false,
    });
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
    vi.mocked(knowledgeApi.save).mockResolvedValue({
      ...manual,
      entry: {
        ...manual.entry,
        organization: { ...manual.entry.organization!, state: 'reviewed' },
      },
    });
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
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'note-manual',
        '产品结论',
        manual.markdown,
        manual.entry.updatedAt,
        expect.objectContaining({ state: 'reviewed', sourceEntryIds: ['entry-a', 'entry-b'] })
      )
    );
    expect(await screen.findByText('已由人工编辑，自动总结不会覆盖。')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('已确认')).toBeInTheDocument();
  });

  it('shows every selected source and removes a source from the actual organization request', async () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      ...DETAIL.entry,
      id: `source-${index}`,
      title: `所选资料 ${index + 1}`,
    }));
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries, total: 4 });
    vi.mocked(knowledgeApi.organize).mockResolvedValue({
      ...DETAIL,
      entry: { ...DETAIL.entry, id: 'new-note', kind: 'note' },
    });
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 所选资料 1' });
    for (const entry of entries) {
      fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${entry.title}` }));
    }
    fireEvent.click(screen.getByRole('button', { name: '人工整理' }));
    // AntD Modal's computed variable border hits the same jsdom/cssstyle issue as buttons.
    // Its real accessible name and focus behavior are checked in the Chrome acceptance pass.
    const dialog = within(
      screen.getByText('创建人工整理笔记').closest('[role="dialog"]')! as HTMLElement
    );
    for (const entry of entries) expect(dialog.getByText(entry.title)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '移除来源 所选资料 4' }));
    expect(dialog.queryByText('所选资料 4')).not.toBeInTheDocument();
    expect(dialog.getByText('已选 3 份来源')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '创建并编辑' }));
    await screen.findByRole('textbox', { name: 'Markdown 正文' });
    expect(knowledgeApi.organize).toHaveBeenCalledWith(
      expect.objectContaining({
        entryIds: ['source-0', 'source-1', 'source-2'],
        mode: 'manual',
      })
    );
  });

  it('does not submit an empty source selection after removing its last item', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 产品讨论' }));
    fireEvent.click(screen.getByRole('button', { name: '人工整理' }));
    const dialog = within(
      screen.getByText('创建人工整理笔记').closest('[role="dialog"]')! as HTMLElement
    );
    fireEvent.click(dialog.getByRole('button', { name: '移除来源 产品讨论' }));
    expect(dialog.getByText('已清空选择。关闭此窗口后，可重新选择来源。')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: '创建并编辑' })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: '创建并编辑' }));
    expect(knowledgeApi.organize).not.toHaveBeenCalled();
  });

  it('returns through nested source records and keeps source navigation away from an edited draft', async () => {
    const primary: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: { ...DETAIL.entry, id: 'note-a', kind: 'note', title: '专题笔记' },
      markdown: '专题结论正文',
      sources: [{ id: 'note-b', title: '原始摘要', available: true }],
    };
    const source: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: { ...DETAIL.entry, id: 'note-b', kind: 'note', title: '原始摘要' },
      markdown: '中间摘要正文',
      sources: [{ id: 'entry-a', title: '最初资料', available: true }],
    };
    vi.mocked(knowledgeApi.detail).mockImplementation(async (id) =>
      id === 'note-a' ? primary : id === 'note-b' ? source : DETAIL
    );
    renderPage('note-a');
    fireEvent.click(await screen.findByRole('button', { name: '原始摘要' }));
    expect(await screen.findByText('中间摘要正文')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '最初资料' }));
    await screen.findByText(/原始记录/);
    fireEvent.click(screen.getByRole('button', { name: '返回上一份资料：原始摘要' }));
    expect(await screen.findByText('中间摘要正文')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' });
    fireEvent.change(editor, { target: { value: '尚未保存的人工总结' } });
    expect(screen.queryByRole('button', { name: /返回上一份资料/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '最初资料' })).toHaveAttribute('target', '_blank');
    expect(editor).toHaveValue('尚未保存的人工总结');
    expect(knowledgeApi.save).not.toHaveBeenCalled();
  });

  it('shows source revision evidence without rewriting maintained notes or inventing old baselines', async () => {
    const maintained: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: { ...DETAIL.entry, id: 'note-version', kind: 'note', humanEdited: true },
      markdown: '人工保留的结论，不随来源更新而改写。',
      sources: [
        {
          id: 'source-current',
          title: '版本一致的原文',
          available: true,
          revisionStatus: 'current',
        },
        {
          id: 'source-changed',
          title: '更新后的原文名',
          available: true,
          revisionStatus: 'changed',
        },
        {
          id: 'source-deleted',
          title: '删除前的资料名',
          available: false,
          revisionStatus: 'deleted',
        },
        {
          id: 'source-unknown',
          title: '没有版本基线的原文',
          available: true,
          revisionStatus: 'unknown',
        },
        { id: 'source-legacy', title: '旧接口原文', available: true },
      ],
    };
    vi.mocked(knowledgeApi.detail).mockResolvedValue(maintained);
    renderPage('note-version');
    await screen.findByText(maintained.markdown);
    expect(screen.getByText('已更新')).toBeInTheDocument();
    expect(screen.getByText('已删除')).toBeInTheDocument();
    expect(screen.getByText('删除前的资料名')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除前的资料名' })).not.toBeInTheDocument();
    expect(screen.getAllByText('版本未记录')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '版本一致的原文' }).parentElement).toHaveTextContent(
      /^版本一致的原文$/
    );
    expect(
      screen.getByText('来源在整理后已有更新，当前笔记内容保持不变，请核对最新原文。')
    ).toBeInTheDocument();
    expect(
      screen.getByText('部分来源未记录整理时的版本，无法判断此后是否更新。')
    ).toBeInTheDocument();
    expect(knowledgeApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' });
    expect(editor).toHaveValue(maintained.markdown);
    fireEvent.change(editor, { target: { value: '继续人工核对的内容' } });
    expect(screen.getByRole('link', { name: '更新后的原文名' })).toHaveAttribute(
      'target',
      '_blank'
    );
    expect(editor).toHaveValue('继续人工核对的内容');
    expect(knowledgeApi.save).not.toHaveBeenCalled();
  });

  it('labels a local structured-file overview distinctly from generated knowledge', async () => {
    const overview: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        kind: 'note',
        summaryMode: 'structured_overview',
        organization: { topic: '数据资料', level: 'summary', state: 'draft' },
      },
      markdown: '对完整结构化文件的统计概览，未经模型提炼。',
    };
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [overview.entry] });
    vi.mocked(knowledgeApi.detail).mockResolvedValue(overview);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
    expect(await screen.findByText(overview.markdown)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('资料概览')).toBeInTheDocument();
  });

  it('shows an overview promoted by its author as topic knowledge', async () => {
    const promoted: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        kind: 'note',
        summaryMode: 'structured_overview',
        humanEdited: true,
        organization: { topic: '数据资料', level: 'knowledge', state: 'reviewed' },
      },
      markdown: '作者补充的跨资料结论。',
    };
    vi.mocked(knowledgeApi.detail).mockResolvedValue(promoted);
    renderPage('entry-a');
    await screen.findByText(promoted.markdown);
    const drawer = within(screen.getByRole('dialog'));
    expect(drawer.getByText('专题知识')).toBeInTheDocument();
    expect(drawer.queryByText('资料概览')).not.toBeInTheDocument();
  });

  it('shows a source synthesis failure and clears it after the background retry completes', async () => {
    const failed: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        summaryMessage: '模型暂时不可用，稍后重试。',
        summaryRetryAt: '2026-10-23T00:00:00Z',
      },
    };
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce(failed)
      .mockResolvedValue({
        ...failed,
        entry: { ...failed.entry, summaryDisposition: 'summarized' },
      });
    renderPage('entry-a');
    expect(await screen.findByText('自动整理尚未成功，原文已保留')).toBeInTheDocument();
    expect(screen.getByText('模型暂时不可用，稍后重试。')).toBeInTheDocument();
    expect(screen.getByText(/下次重试/)).toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() =>
      expect(screen.queryByText('自动整理尚未成功，原文已保留')).not.toBeInTheDocument()
    );
    expect(knowledgeApi.detail).toHaveBeenCalledTimes(2);
    fireEvent(document, new Event('visibilitychange'));
    expect(knowledgeApi.detail).toHaveBeenCalledTimes(2);
  });

  it('updates an active source summary phase and stops polling once source processing completes', async () => {
    vi.mocked(knowledgeApi.detail)
      .mockResolvedValueOnce({
        ...DETAIL,
        entry: {
          ...DETAIL.entry,
          summaryProgress: {
            phase: 'waiting_model',
            stage: 'map',
            completed: 0,
            total: 2,
          },
        },
      })
      .mockResolvedValueOnce({
        ...DETAIL,
        entry: {
          ...DETAIL.entry,
          summaryProgress: {
            phase: 'waiting_model',
            stage: 'map',
            completed: 1,
            total: 2,
          },
        },
      })
      .mockResolvedValueOnce(DETAIL);
    renderPage('entry-a');
    expect(await screen.findByText('等待模型响应 · 共 2 段')).toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText('已完成 1/2 段 · 等待模型响应')).toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(screen.queryByText('知识整理进度')).not.toBeInTheDocument());
    fireEvent(document, new Event('visibilitychange'));
    expect(knowledgeApi.detail).toHaveBeenCalledTimes(3);
  });

  it('keeps the current long-source segment while its background summary progress updates', async () => {
    vi.mocked(knowledgeApi.detail).mockImplementation(async (_id, _signal, page) => ({
      ...DETAIL,
      entry: {
        ...DETAIL.entry,
        summaryProgress: { phase: 'waiting_model', stage: 'map', completed: 0, total: 1 },
      },
      markdown: page?.offset ? '第二段继续阅读' : '第一段原文',
      page: {
        offset: page?.offset ?? 0,
        totalChars: 40_008,
        nextOffset: page?.offset ? null : 40_000,
        hasMore: !page?.offset,
      },
    }));
    renderPage('entry-a');
    fireEvent.click(await screen.findByRole('button', { name: '下一段' }));
    expect(await screen.findByText('第二段继续阅读')).toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() =>
      expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', expect.any(AbortSignal), {
        offset: 40_000,
        limit: 40_000,
      })
    );
    expect(screen.getByText('第二段继续阅读')).toBeInTheDocument();
    expect(screen.queryByText('第一段原文')).not.toBeInTheDocument();
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
    vi.mocked(knowledgeApi.save).mockResolvedValue(completed);
    fireEvent.click(screen.getByRole('button', { name: '编辑', exact: true }));
    await screen.findByRole('textbox', { name: 'Markdown 正文' });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'automatic-note',
        '设计结论',
        completed.markdown,
        completed.entry.updatedAt,
        expect.objectContaining({ state: 'draft' })
      )
    );
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
    fireEvent.click(screen.getByRole('button', { name: '下载 Markdown 归档' }));
    await waitFor(() =>
      expect(knowledgeApi.downloadMarkdown).toHaveBeenCalledWith('entry-a', '产品讨论')
    );
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

  it('opens a deep search match with bounded reading, restores source-return position and edits the full body', async () => {
    const matchedEntry = {
      ...DETAIL.entry,
      kind: 'note' as const,
      searchMatch: { offset: 80_000, contentHash: DETAIL.contentHash },
    };
    const fullText = `${'开头原文'.padEnd(80_000, '文')}命中尾部`;
    const complete: KnowledgeEntryDetail = {
      ...DETAIL,
      entry: matchedEntry,
      markdown: fullText,
      sources: [
        { id: 'other-source', title: '整理原文', available: true, revisionStatus: 'current' },
      ],
    };
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [matchedEntry] });
    vi.mocked(knowledgeApi.detail).mockImplementation(async (id, _signal, page) => {
      if (id === 'other-source') {
        return { ...DETAIL, entry: { ...DETAIL.entry, id }, markdown: '来源正文' };
      }
      if (!page) return complete;
      return {
        ...complete,
        markdown: fullText.slice(page.offset, page.offset + 40_000),
        page: {
          offset: page.offset,
          totalChars: fullText.length,
          nextOffset: page.offset + 40_000 < fullText.length ? page.offset + 40_000 : null,
          hasMore: page.offset + 40_000 < fullText.length,
        },
      };
    });
    renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '命中尾部' },
    });
    await waitFor(() =>
      expect(vi.mocked(knowledgeApi.catalog).mock.calls.at(-1)?.[0]).toBe('命中尾部')
    );
    fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
    expect(await screen.findByText('命中尾部', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('已定位搜索命中')).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', expect.any(AbortSignal), {
      offset: 80_000,
      limit: 40_000,
      contentHash: DETAIL.contentHash,
    });
    expect(vi.mocked(knowledgeApi.detail).mock.calls.every((call) => call[2])).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '整理原文' }));
    await screen.findByText('来源正文');
    fireEvent.click(screen.getByRole('button', { name: '返回上一份资料：产品讨论' }));
    await screen.findByText('命中尾部', { exact: true });
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', expect.any(AbortSignal), {
      offset: 80_000,
      limit: 40_000,
      contentHash: DETAIL.contentHash,
    });
    fireEvent.click(screen.getByRole('button', { name: '从头阅读' }));
    await waitFor(() => expect(screen.queryByText('已定位搜索命中')).not.toBeInTheDocument());
    expect(screen.getByText(/^开头原文/)).toBeInTheDocument();
    expect(screen.queryByText('命中尾部', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('textbox', { name: 'Markdown 正文' })).toHaveValue(fullText);
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a');
    expect(knowledgeApi.save).not.toHaveBeenCalled();
  });

  it('clears stale search locations and page boundaries only when a background poll changes the body hash', async () => {
    let contentHash = DETAIL.contentHash;
    let completed = 0;
    const entry = {
      ...DETAIL.entry,
      kind: 'note' as const,
      generation: { state: 'running' as const },
      searchMatch: { offset: 39_999, contentHash },
    };
    vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [entry] });
    vi.mocked(knowledgeApi.detail).mockImplementation(async (_id, _signal, page) => {
      const offset = page?.offset ?? 0;
      return {
        ...DETAIL,
        entry: {
          ...entry,
          generation: {
            state: 'running',
            progress: { phase: 'processing', stage: 'map', completed, total: 3 },
          },
        },
        contentHash,
        markdown: `${contentHash === DETAIL.contentHash ? '原文' : '最新正文'}-${offset}`,
        page: { offset, totalChars: 150_000, nextOffset: offset + 39_999, hasMore: true },
      };
    });
    renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
      target: { value: '位置' },
    });
    await waitFor(() =>
      expect(vi.mocked(knowledgeApi.catalog).mock.calls.at(-1)?.[0]).toBe('位置')
    );
    fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
    await screen.findByText('已定位搜索命中');
    completed = 1;
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText(/已完成 1\/3 段/);
    expect(screen.getByText('已定位搜索命中')).toBeInTheDocument();
    expect(screen.queryByText('资料正文已更新，当前显示最新内容。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一段' }));
    await screen.findByText('原文-79998');
    contentHash = 'new-body-hash';
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('最新正文-79998');
    expect(screen.getByText('资料正文已更新，当前显示最新内容。')).toBeInTheDocument();
    expect(screen.queryByText('已定位搜索命中')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上一段' }));
    await screen.findByText('最新正文-39998');
    expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', undefined, {
      offset: 39_998,
      limit: 40_000,
      contentHash: 'new-body-hash',
    });
  });

  it.each([409, 503])(
    'handles search location status %s without hiding non-conflict errors',
    async (status) => {
      const entry = {
        ...DETAIL.entry,
        searchMatch: { offset: 80_000, contentHash: 'old-version' },
      };
      vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [entry] });
      vi.mocked(knowledgeApi.detail)
        .mockRejectedValueOnce(Object.assign(new Error('定点读取失败'), { status }))
        .mockResolvedValue({ ...DETAIL, contentHash: 'new-version', markdown: '最新版本开头' });
      renderPage();
      fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
        target: { value: '定位' },
      });
      await waitFor(() =>
        expect(vi.mocked(knowledgeApi.catalog).mock.calls.at(-1)?.[0]).toBe('定位')
      );
      fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
      if (status === 409) {
        await screen.findByText('最新版本开头');
        expect(screen.getByText('这份资料已有更新，已从头打开最新版本。')).toBeInTheDocument();
        expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', expect.any(AbortSignal), {
          offset: 0,
          limit: 40_000,
        });
        expect(knowledgeApi.detail).toHaveBeenCalledTimes(2);
      } else {
        await screen.findByText('定点读取失败');
        expect(knowledgeApi.detail).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('最新版本开头')).not.toBeInTheDocument();
      }
      expect(screen.queryByText('已定位搜索命中')).not.toBeInTheDocument();
    }
  );

  it.each([false, true])(
    'distinguishes metadata matches from a valid zero-offset body match: %s',
    async (bodyMatch) => {
      const entry = {
        ...DETAIL.entry,
        ...(bodyMatch ? { searchMatch: { offset: 0, contentHash: DETAIL.contentHash } } : {}),
      };
      vi.mocked(knowledgeApi.catalog).mockResolvedValue({ ...CATALOG, entries: [entry] });
      renderPage();
      fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), {
        target: { value: '产品' },
      });
      await waitFor(() =>
        expect(vi.mocked(knowledgeApi.catalog).mock.calls.at(-1)?.[0]).toBe('产品')
      );
      fireEvent.click(await screen.findByRole('button', { name: '产品讨论' }));
      await screen.findByText(/原始记录/);
      expect(knowledgeApi.detail).toHaveBeenLastCalledWith('entry-a', expect.any(AbortSignal), {
        offset: 0,
        limit: 40_000,
        ...(bodyMatch ? { contentHash: DETAIL.contentHash } : {}),
      });
      expect(Boolean(screen.queryByText('已定位搜索命中'))).toBe(bodyMatch);
    }
  );

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

  it('returns to the actual prior segment boundary after emoji-safe offsets and a source round trip', async () => {
    vi.mocked(knowledgeApi.detail).mockImplementation(async (id, _signal, page) => {
      if (id === 'boundary-source') {
        return { ...DETAIL, entry: { ...DETAIL.entry, id }, markdown: '边界来源正文' };
      }
      const offset = page?.offset ?? 0;
      return {
        ...DETAIL,
        sources: [{ id: 'boundary-source', title: '边界来源', available: true }],
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
    fireEvent.click(screen.getByRole('button', { name: '边界来源' }));
    await screen.findByText('边界来源正文');
    fireEvent.click(screen.getByRole('button', { name: '返回上一份资料：产品讨论' }));
    await screen.findByText('第三段🙂');
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
