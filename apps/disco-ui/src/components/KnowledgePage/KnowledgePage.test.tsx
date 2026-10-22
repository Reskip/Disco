import type { KnowledgeEntryDetail, KnowledgeLibraryStatus } from '@disco/core/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    list: vi.fn(),
    status: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    uploadDocument: vi.fn(),
    exportLibrary: vi.fn(),
    downloadAttachment: vi.fn(),
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
    vi.mocked(knowledgeApi.list).mockResolvedValue({ entries: [DETAIL.entry], total: 1 });
    vi.mocked(knowledgeApi.status).mockResolvedValue(STATUS);
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
    expect(knowledgeApi.detail).toHaveBeenCalledWith('entry-a', expect.any(AbortSignal));
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
    vi.mocked(knowledgeApi.list).mockResolvedValue({ entries: [], total: 0 });
    renderPage('entry-a');
    expect(await screen.findByText(/原始记录/)).toBeInTheDocument();
    expect(knowledgeApi.detail).toHaveBeenCalledWith('entry-a', expect.any(AbortSignal));
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
    vi.mocked(knowledgeApi.list).mockResolvedValue({ entries: [detail.entry], total: 1 });
    vi.mocked(knowledgeApi.detail).mockResolvedValue(detail);
    renderPage();
    expect(await screen.findByText('正文解析失败 · 原件已保留')).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '我的人工修改' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('这份资料已有新修改')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toHaveValue('我的人工修改');
    expect(knowledgeApi.save).toHaveBeenCalledWith(
      'entry-a',
      '产品讨论',
      '我的人工修改',
      DETAIL.entry.updatedAt
    );
    fireEvent.focus(window);
    await waitFor(() => expect(knowledgeApi.list).toHaveBeenCalledTimes(2));
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
    vi.mocked(knowledgeApi.save).mockResolvedValue({ ...note, markdown: '补充正文' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
    fireEvent.change(screen.getByRole('textbox', { name: '资料标题' }), {
      target: { value: '新笔记' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 正文' }), {
      target: { value: '补充正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(knowledgeApi.save).toHaveBeenCalledWith(
        'note-a',
        '新笔记',
        '补充正文',
        note.entry.updatedAt
      )
    );
    expect(knowledgeApi.create).toHaveBeenCalledTimes(1);
  });
});
