import type { DiscoClient, Message } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../../hooks/useAuthenticatedUpload';
import { MessageBlock } from './MessageBlock';
import { buildVisualizationDocument } from './VisualizationCitation';

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

describe('MessageBlock layout', () => {
  it('lets a user bubble shrink around intrinsically wide markdown', () => {
    const message = {
      message_id: 'message-1',
      session_id: 'session-1',
      type: 'message',
      role: 'user',
      index: 0,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: '```json\n{"path":"/an/intrinsically/very/wide/path"}\n```',
      content_preview: 'wide code',
    } as unknown as Message;

    const { container } = render(<MessageBlock message={message} />);
    const row = container.querySelector<HTMLElement>('.disco-message-row.is-user');
    const surface = container.querySelector<HTMLElement>('.disco-message-surface');

    expect(row).toHaveClass('disco-message-row', 'is-user');
    expect(surface).toHaveClass('disco-message-surface');
  });

  it('renders provider billing recovery instead of raw zero-turn text', () => {
    const onOpenSettings = vi.fn();
    const message = {
      message_id: 'message-2',
      session_id: 'session-1',
      type: 'system',
      role: 'system',
      index: 1,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: 'Credit balance is too low',
      content_preview: 'Credit balance is too low',
      metadata: {
        error_kind: 'provider_credit_exhausted',
        tool: 'claude-code',
      },
    } as unknown as Message;

    render(<MessageBlock message={message} onOpenAgenticToolSettings={onOpenSettings} />);

    expect(screen.getByText(/needs available credit or quota/i)).toBeVisible();
    expect(screen.getByText(/workspace and teammate are still set up/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /Open Claude Code's console/i })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Open Claude Code settings/i }));
    expect(onOpenSettings).toHaveBeenCalledWith('claude-code');
    expect(screen.queryByText(/credit balance is too low/i)).not.toBeInTheDocument();
  });

  it.each([
    ['missing_credential', /couldn't verify your Claude Code connection/i],
    ['provider_credit_exhausted', /needs available credit or quota/i],
  ] as const)('renders %s recovery for empty content', async (errorKind, recoveryText) => {
    const message = {
      message_id: `empty-${errorKind}`,
      session_id: 'session-1',
      type: 'system',
      role: 'system',
      index: 2,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: '',
      content_preview: '',
      metadata: {
        error_kind: errorKind,
        tool: 'claude-code',
      },
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(await screen.findByText(recoveryText)).toBeVisible();
  });

  it('keeps TodoWrite bookkeeping out of the chronological behavior list', () => {
    const message = {
      message_id: 'todo-message',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 3,
      timestamp: '2026-08-26T00:00:00.000Z',
      content: [
        {
          type: 'tool_use',
          id: 'todo-1',
          name: 'TodoWrite',
          input: {
            todos: [{ content: '检查布局', status: 'in_progress' }],
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'todo-1',
          content: 'ok',
        },
      ],
      content_preview: '更新任务计划',
    } as unknown as Message;

    const { container } = render(<MessageBlock message={message} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/更新任务计划/)).not.toBeInTheDocument();
  });

  it('renders executor-appended publication metadata as native media controls', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['published bytes'], { type: 'application/octet-stream' }), {
          status: 200,
        })
    );
    let objectUrlIndex = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:assistant-publication-${++objectUrlIndex}`),
        revokeObjectURL: vi.fn(),
      })
    );

    const message = {
      message_id: 'published-message',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 4,
      timestamp: '2026-08-29T00:00:00.000Z',
      content: [
        {
          type: 'text',
          text: [
            '文件已经发布。',
            '',
            'Attached files:',
            '- [结果.png](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000001) (image/png, 12 B)',
            '- [报告.pdf](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000002) (application/pdf, 13 B)',
            '- [说明.mp3](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000003) (audio/mpeg, 14 B)',
            '- [演示.mp4](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000004) (video/mp4, 15 B)',
            '- [数据.csv](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000005) (text/csv, 16 B)',
          ].join('\n'),
        },
      ],
      content_preview: '文件已经发布。',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(screen.getByText('文件已经发布。')).toBeVisible();
    expect(await screen.findByRole('img', { name: '结果.png' })).toHaveAttribute(
      'src',
      'blob:assistant-publication-1'
    );
    expect(screen.getByRole('button', { name: '打开 报告.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: '播放 说明.mp3' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '播放 演示.mp4' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '下载 数据.csv' })).toBeEnabled();
    expect(screen.queryByText('Attached files:')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders structured output citations as native document cards without protocol text', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['pdf bytes'], { type: 'application/pdf' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:structured-pdf'),
        revokeObjectURL: vi.fn(),
      })
    );
    const message = {
      message_id: 'structured-file-citation',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 5,
      timestamp: '2026-09-02T00:00:00.000Z',
      content: [
        { type: 'text', text: '引用前。' },
        {
          type: 'file_citation',
          filename: '报告.pdf',
          purpose: 'output',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000010',
          mime_type: 'application/pdf',
          size: 2048,
          available: true,
        },
        { type: 'text', text: '引用后。' },
      ],
      content_preview: '报告已经生成。',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    const before = screen.getByText('引用前。');
    const card = await screen.findByRole('button', { name: '打开 报告.pdf' });
    const after = screen.getByText('引用后。');
    expect(before).toBeVisible();
    expect(card).toBeVisible();
    expect(after).toBeVisible();
    expect(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('输出文件')).toBeVisible();
    expect(screen.queryByText(/codex-file-citation/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a published visualization inline at its cited position', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<main><h1>湖滨路线</h1></main>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:structured-visualization'),
        revokeObjectURL: vi.fn(),
      })
    );
    const message = {
      message_id: 'structured-visualization',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 6,
      timestamp: '2026-09-04T00:00:00.000Z',
      content: [
        { type: 'text', text: '路线如下。' },
        {
          type: 'file_citation',
          filename: 'run-route-map.html',
          purpose: 'output',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000020',
          mime_type: 'text/html',
          size: 2048,
          available: true,
          locator: { artifactKind: 'visualization', label: '湖滨 5K 跑步轨迹' },
          presentation: {
            type: 'visualization',
            mode: 'wide',
            title: '湖滨 5K 跑步轨迹',
          },
        },
        { type: 'text', text: '可以缩放查看。' },
      ],
      content_preview: '路线如下。',
    } as unknown as Message;

    const { container } = render(<MessageBlock message={message} />);

    const before = screen.getByText('路线如下。');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载交互图' }));
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const frame = container.querySelector('iframe')!;
    const after = screen.getByText('可以缩放查看。');
    expect(before.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('src')).toContain('/visualization-frame.html#');
    expect(frame).not.toHaveAttribute('srcdoc');
    const postedDocument = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(postedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'disco:visualization-document',
        html: expect.stringContaining('<h1>湖滨路线</h1>'),
      }),
      '*'
    );
    expect(
      buildVisualizationDocument({
        fragment: '<h1>湖滨路线</h1>',
        title: '湖滨 5K 跑步轨迹',
        dark: false,
        channelId: 'test-channel',
      })
    ).toContain('Content-Security-Policy');
    expect(screen.getByText('交互图')).toBeVisible();
    expect(screen.getByRole('button', { name: '放大查看 湖滨 5K 跑步轨迹' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '下载 run-route-map.html' })).toBeEnabled();
    expect(screen.queryByText(/visualize/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('hides local paths in a historical unpublished visualization directive', () => {
    const localPath = 'E:/Disco/data/disco/worktrees/user-one/standalone/session/run-map.html';
    const message = {
      message_id: 'legacy-unpublished-visualization',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 7,
      timestamp: '2026-09-04T00:00:00.000Z',
      content: `路线：visualize{"path":"${localPath}","title":"湖滨路线"}。`,
      content_preview: '路线。',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(screen.getByLabelText('交互图 湖滨路线')).toBeVisible();
    expect(screen.getByText('历史文件未发布')).toBeVisible();
    expect(screen.queryByText(/visualize/)).not.toBeInTheDocument();
    expect(screen.queryByText((text) => text.includes('E:/'))).not.toBeInTheDocument();
  });

  it('restores citation positions for messages saved by the first live contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Blob(['pdf'], { type: 'application/pdf' }), { status: 200 })
      )
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:legacy-structured-pdf'),
        revokeObjectURL: vi.fn(),
      })
    );
    const message = {
      message_id: 'legacy-structured-file-citations',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 6,
      timestamp: '2026-09-02T00:00:00.000Z',
      content: [
        { type: 'text', text: '结论前。报告甲.pdf中间说明。报告乙.pdf结论后。' },
        {
          type: 'file_citation',
          filename: '报告甲.pdf',
          purpose: 'source',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000021',
          mime_type: 'application/pdf',
          available: true,
        },
        {
          type: 'file_citation',
          filename: '报告乙.pdf',
          purpose: 'source',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000022',
          mime_type: 'application/pdf',
          available: true,
        },
      ],
      content_preview: '结论前。',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    const before = screen.getByText('结论前。');
    const first = await screen.findByRole('button', { name: '打开 报告甲.pdf' });
    const middle = screen.getByText('中间说明。');
    const second = await screen.findByRole('button', { name: '打开 报告乙.pdf' });
    const after = screen.getByText('结论后。');
    expect(before.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(middle.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('recovers a historical staged source citation but never exposes its local path', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Blob(['pdf'], { type: 'application/pdf' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:legacy-pdf'),
        revokeObjectURL: vi.fn(),
      })
    );
    const localPath =
      'E:\\Disco\\data\\worktrees\\user-zsy\\sessions\\one\\.disco\\session-staging\\session-1\\upl_00000000-0000-4000-8000-000000000011\\原始资料.pdf';
    const escaped = localPath.replaceAll('\\', '\\\\');
    const message = {
      message_id: 'legacy-file-citation',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 6,
      timestamp: '2026-09-02T00:00:00.000Z',
      content: `参考 :codex-file-citation{path="${escaped}" purpose="source" artifact_kind="pdf" page_number="2"}。`,
      content_preview: '参考文件。',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(await screen.findByRole('button', { name: '打开 原始资料.pdf' })).toBeVisible();
    expect(screen.getByText('引用文件')).toBeVisible();
    expect(screen.getByText('第 2 页')).toBeVisible();
    expect(screen.queryByText(/session-staging/)).not.toBeInTheDocument();
    expect(screen.queryByText(/codex-file-citation/)).not.toBeInTheDocument();
  });

  it('renders historical Codex capacity failures with working retry and model actions', async () => {
    const getTask = vi.fn().mockResolvedValue({ full_prompt: '原始请求' });
    const retryPrompt = vi.fn().mockResolvedValue({ task_id: 'retry-task' });
    const client = {
      service: vi.fn(() => ({ get: getTask })),
      sessions: { prompt: retryPrompt },
    } as unknown as DiscoClient;
    const modelTrigger = document.createElement('button');
    modelTrigger.className = 'ant-select-selector';
    const modelContainer = document.createElement('div');
    modelContainer.className = 'disco-simple-composer-model';
    modelContainer.append(modelTrigger);
    document.body.append(modelContainer);
    const openModel = vi.fn();
    modelTrigger.addEventListener('click', openModel);
    const message = {
      message_id: 'capacity-message',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 4,
      timestamp: '2026-08-27T00:00:00.000Z',
      content: 'Codex stream error: Selected model is at capacity. Please try a different model.',
      content_preview: 'Codex stream error',
    } as unknown as Message;

    render(
      <MessageBlock message={message} client={client} sessionId="session-1" taskId="task-1" />
    );

    expect(screen.getByText(/所选模型当前繁忙/)).toBeVisible();
    expect(screen.queryByText(/Selected model is at capacity/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即重试' }));
    await waitFor(() => expect(retryPrompt).toHaveBeenCalledWith('session-1', '原始请求'));
    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(screen.getByRole('button', { name: '已重新提交' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));
    expect(openModel).toHaveBeenCalledOnce();
    modelContainer.remove();
  });

  it('keeps model switching out of mobile capacity recovery', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    const message = {
      message_id: 'mobile-capacity-message',
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index: 5,
      timestamp: '2026-08-30T00:00:00.000Z',
      content: 'Codex stream error: Selected model is at capacity. Please try a different model.',
      content_preview: 'Codex stream error',
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(screen.queryByRole('button', { name: '切换模型' })).not.toBeInTheDocument();
  });
});
