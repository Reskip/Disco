import type { DiscoClient, Session } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { discoStore } from '../../store/discoStore';
import type { UploadFilesToSessionResult } from '../FileUpload/upload';
import SessionPanel from './SessionPanel';

const uploadMockState = vi.hoisted(() => ({
  uploadFilesToSession: vi.fn(),
}));
const reactiveMockState = vi.hoisted(() => ({
  state: { tasks: [] as any[], messagesByTask: new Map<string, any[]>() },
}));

vi.mock('../FileUpload/upload', () => ({
  uploadFilesToSession: uploadMockState.uploadFilesToSession,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: ({
    pendingComposerSubmission,
    footerSlot,
  }: {
    pendingComposerSubmission?: any;
    footerSlot?: React.ReactNode;
  }) => (
    <>
      {pendingComposerSubmission ? (
        <div data-testid="pending-composer-submission">
          <span>{pendingComposerSubmission.text}</span>
          <span>
            {pendingComposerSubmission.activity === 'attachments'
              ? '正在准备附件，完成后开始处理'
              : '补充信息正在交给 Agent，不会打断当前任务'}
          </span>
          {pendingComposerSubmission.attachments.map((attachment: any) => (
            <img key={attachment.id} src={attachment.previewUrl} alt={attachment.file.name} />
          ))}
        </div>
      ) : null}
      {footerSlot}
    </>
  ),
}));

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ handle: null, state: reactiveMockState.state }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    agentic_tool: 'codex',
    status: 'completed',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Session;
}

function makeClient(): DiscoClient {
  const taskEvents = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    service: vi.fn((name: string) => {
      if (name === 'tasks') return taskEvents;
      return { find: vi.fn().mockResolvedValue({ data: [] }) };
    }),
  } as unknown as DiscoClient;
}

function renderSessionPanel({
  onSendPrompt = vi.fn(),
  onFork = vi.fn(),
  onBtwFork = vi.fn(),
  session = makeSession(),
}: {
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: string,
    options?: { steer?: boolean }
  ) => boolean | undefined | Promise<boolean | undefined>;
  onFork?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwFork?: (sessionId: string, prompt: string) => Promise<void>;
  session?: Session;
} = {}) {
  const renderTree = (nextSession: Session) => (
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AppActionsProvider value={{ onSendPrompt, onFork, onBtwFork }}>
          <SessionPanel client={makeClient()} session={nextSession} open onClose={vi.fn()} />
        </AppActionsProvider>
      </ConnectionProvider>
    </App>
  );
  const renderResult = render(renderTree(session));
  return {
    onSendPrompt,
    onFork,
    onBtwFork,
    rerenderSession: (nextSession: Session) => renderResult.rerender(renderTree(nextSession)),
    ...renderResult,
  };
}

describe('SessionPanel composer send', () => {
  beforeEach(() => {
    discoStore.getState().reset();
    uploadMockState.uploadFilesToSession.mockReset();
    reactiveMockState.state = { tasks: [], messagesByTask: new Map() };
    uploadMockState.uploadFilesToSession.mockImplementation(
      async ({ files }: { files: File[] }) => ({
        success: true,
        files: files.map((file, index) => ({
          filename: file.name,
          ref: `upl_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          size: file.size,
          mimeType: file.type,
          createdAt: new Date().toISOString(),
          expiresAt: null,
        })),
      })
    );
    localStorage.clear();
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:preview'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
  });

  it('把运行中 Codex 会话的输入持久化排队', async () => {
    const onSendPrompt = vi.fn().mockResolvedValue(true);
    renderSessionPanel({ onSendPrompt, session: makeSession({ status: 'running' }) });

    const textarea = screen.getByPlaceholderText('输入下一条消息，当前任务完成后自动开始');
    fireEvent.change(textarea, { target: { value: '补充：完成当前步骤后先运行测试' } });
    fireEvent.click(screen.getByRole('button', { name: '排队消息' }));

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      '补充：完成当前步骤后先运行测试',
      expect.any(String)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeEnabled());
  });

  it('accepts send during upload, freezes that message, and preserves later draft text', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('当前对话文件拖放区域');
    const sendStartFile = new File(['image'], 'chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [sendStartFile],
      },
    });

    const textarea = screen.getByPlaceholderText(/随心输入/i);
    fireEvent.change(textarea, { target: { value: 'Compare this chart' } });

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ destination: expect.anything() })
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ files: [sendStartFile], notifyAgent: false })
    );

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.getByText('Compare this chart')).toBeInTheDocument();
    expect(screen.getByText('正在准备附件，完成后开始处理')).toBeInTheDocument();
    expect(screen.getByAltText('chart.png')).toBeInTheDocument();
    expect(onSendPrompt).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: 'This belongs to the next message' } });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000001',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- [chart.png](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000001) (image/png, 5 B)\n\nCompare this chart',
      expect.any(String)
    );
    expect(textarea).toHaveValue('This belongs to the next message');
  });

  it('cancels an old preupload without mixing the newly selected session composer', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { rerenderSession } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('当前对话文件拖放区域');
    const sendStartFile = new File(['old image'], 'old-session-chart.png', {
      type: 'image/png',
    });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [sendStartFile],
      },
    });

    const textarea = screen.getByPlaceholderText(/随心输入/i);
    fireEvent.change(textarea, { target: { value: 'Old session prompt snapshot' } });

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', files: [sendStartFile] })
    );

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue(''));
    fireEvent.change(textarea, { target: { value: 'New session prompt must stay local' } });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'old-session-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000002',
          size: 9,
          mimeType: 'image/png',
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('New session prompt must stay local');
  });

  it('shows an immediate local message and waits for upload before starting the agent', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('当前对话文件拖放区域');
    const file = new File(['rapid image'], 'rapid-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/随心输入/i);
    fireEvent.change(textarea, { target: { value: 'Summarize this rapid chart' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);

    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(sendButton).toBeDisabled();
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('');
    expect(screen.getByText('Summarize this rapid chart')).toBeInTheDocument();
    expect(screen.getByAltText('rapid-chart.png')).toBeInTheDocument();
    expect(screen.getByText('正在准备附件，完成后开始处理')).toBeInTheDocument();

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'rapid-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000003',
          size: 11,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- [rapid-chart.png](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000003) (image/png, 11 B)\n\nSummarize this rapid chart',
      expect.any(String)
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ destination: expect.anything() })
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ files: [file], notifyAgent: false })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByLabelText('预览 rapid-chart.png')).not.toBeInTheDocument();
  });

  it('removes the optimistic attachment state as soon as the admitted task is visible', async () => {
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'single-state.png',
          ref: 'upl_00000000-0000-4000-8000-000000000006',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });
    const onSendPrompt = vi.fn().mockImplementation(async () => {
      reactiveMockState.state = {
        tasks: [{ task_id: 'task-visible', status: 'running', metadata: {} }],
        messagesByTask: new Map(),
      };
      return { taskId: 'task-visible', messageId: 'message-later' };
    });
    const { container } = renderSessionPanel({ onSendPrompt });

    fireEvent.drop(screen.getByLabelText('当前对话文件拖放区域'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['image'], 'single-state.png', { type: 'image/png' })],
      },
    });
    fireEvent.change(screen.getByPlaceholderText(/随心输入/i), {
      target: { value: '只显示一次这条消息' },
    });
    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId('pending-composer-submission')).not.toBeInTheDocument()
    );
  });

  it('removes the attachment spinner when realtime wins the prompt-response race', async () => {
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'race.png',
          ref: 'upl_00000000-0000-4000-8000-000000000007',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });
    const response = deferred<any>();
    const onSendPrompt = vi.fn().mockReturnValue(response.promise);
    const session = makeSession();
    const { container, rerenderSession } = renderSessionPanel({ onSendPrompt, session });

    fireEvent.drop(screen.getByLabelText('当前对话文件拖放区域'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['image'], 'race.png', { type: 'image/png' })],
      },
    });
    fireEvent.change(screen.getByPlaceholderText(/随心输入/i), {
      target: { value: '不应出现双重转圈' },
    });
    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('pending-composer-submission')).toBeInTheDocument();

    reactiveMockState.state = {
      tasks: [{ task_id: 'task-from-realtime', status: 'running', metadata: {} }],
      messagesByTask: new Map(),
    };
    rerenderSession(session);

    await waitFor(() =>
      expect(screen.queryByTestId('pending-composer-submission')).not.toBeInTheDocument()
    );
    response.resolve({ taskId: 'task-from-realtime', messageId: 'message-from-http' });
  });

  it('keeps send available while upload is active but still locks attachment mutation', async () => {
    localStorage.setItem('disco-footer-prefs', JSON.stringify({ pinnedItems: ['upload'] }));
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('当前对话文件拖放区域');
    const file = new File(['chart'], 'uploading-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/随心输入/i);
    fireEvent.change(textarea, { target: { value: 'Summarize this while upload locks actions' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(sendButton).not.toBeDisabled();
      expect(screen.getByTestId('upload-bar-btn')).toBeDisabled();
    });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'uploading-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000004',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
  });

  it('preserves prompt and uploaded attachments when prompt submission fails after upload', async () => {
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'preserve-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000005',
          size: 12,
          mimeType: 'image/png',
        },
      ],
    });
    const onSendPrompt = vi.fn().mockResolvedValue(false);
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('当前对话文件拖放区域');
    const file = new File(['preserve image'], 'preserve-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/随心输入/i);
    fireEvent.change(textarea, { target: { value: 'Keep this prompt if submit fails' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- [preserve-chart.png](https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000005) (image/png, 12 B)\n\nKeep this prompt if submit fails',
      expect.any(String)
    );
    expect(textarea).toHaveValue('Keep this prompt if submit fails');
    expect(screen.getByLabelText('预览 preserve-chart.png')).toBeInTheDocument();
  });

  it('does not expose fork, spawn, or side-question controls', () => {
    const onFork = vi.fn().mockResolvedValue(undefined);
    const onBtwFork = vi.fn().mockResolvedValue(undefined);
    renderSessionPanel({ onFork, onBtwFork });

    expect(screen.queryByLabelText('Fork session')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Spawn subsession')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ask side question via BTW fork')).not.toBeInTheDocument();
    expect(onFork).not.toHaveBeenCalled();
    expect(onBtwFork).not.toHaveBeenCalled();
  });

  it('accepts arbitrary file types before upload/send', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    fireEvent.drop(screen.getByLabelText('当前对话文件拖放区域'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['<script>'], 'unsafe.html', { type: 'text/html' })],
      },
    });

    await waitFor(() => expect(screen.getByLabelText('预览 unsafe.html')).toBeInTheDocument());

    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1);
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText(/不支持的文件类型/)).not.toBeInTheDocument();
  });

  it('shows a visible cap error and rejects an incoming batch over 10 files', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    const files = Array.from(
      { length: 11 },
      (_, index) =>
        new File(['x'], `pending-${String(index).padStart(2, '0')}.txt`, { type: 'text/plain' })
    );
    fireEvent.drop(screen.getByLabelText('当前对话文件拖放区域'), {
      dataTransfer: {
        types: ['Files'],
        files,
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(/pending-00.txt: 最多可添加 10 个待上传文件（另有 10 个）/).length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByLabelText('预览 pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('预览 pending-09.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('预览 pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it('prioritizes the visible cap error for mixed invalid and over-cap batches', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    const files = [
      new File(['<svg />'], 'bad.svg', { type: 'image/svg+xml' }),
      ...Array.from(
        { length: 11 },
        (_, index) =>
          new File(['x'], `pending-${String(index).padStart(2, '0')}.txt`, {
            type: 'text/plain',
          })
      ),
    ];
    fireEvent.drop(screen.getByLabelText('当前对话文件拖放区域'), {
      dataTransfer: {
        types: ['Files'],
        files,
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(/bad.svg: 最多可添加 10 个待上传文件（另有 11 个）/).length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/bad.svg: 不支持的文件类型/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('预览 pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('预览 pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
});
