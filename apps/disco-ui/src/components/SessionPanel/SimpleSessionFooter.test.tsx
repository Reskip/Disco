import type { EffortLevel, Session } from '@disco-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSelectorProps } from '../ModelSelector/ModelSelector';
import { SimpleSessionFooter } from './SimpleSessionFooter';

vi.mock('../ModelSelector', () => ({
  ModelSelector: ({ value, onChange, mobile }: ModelSelectorProps) => (
    <button
      type="button"
      data-testid="model-selector-stub"
      data-mobile={mobile}
      onClick={() => onChange?.({ ...value, mode: 'alias', model: 'gpt-6-sol' })}
    >
      {value?.model ?? 'Codex 模型'}
    </button>
  ),
}));

vi.mock('../EffortSelector', () => ({
  EffortSelector: ({ value }: { value?: EffortLevel }) => (
    <div data-testid="effort-selector-stub">{value}</div>
  ),
}));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  agentic_tool: 'codex',
  created_by: 'user-1',
  status: 'idle',
} as unknown as Session & { agentic_tool: 'codex' };

const baseProps = {
  session,
  currentUserId: 'user-1',
  client: null,
  toolCaps: {
    reasoningEffortLevels: ['low', 'medium', 'high'] as EffortLevel[],
    defaultReasoningEffort: 'medium' as EffortLevel,
  },
  tokenBreakdown: {
    total: 238_416,
    input: 200_000,
    output: 38_416,
    cacheRead: 0,
    cacheCreation: 0,
    cost: 0,
  },
  effortLevel: 'high' as EffortLevel,
  serviceTier: 'default' as const,
  isRunning: false,
  isStopping: false,
  stopRequestInFlight: false,
  hasInput: true,
  connectionDisabled: false,
  promptInputSlot: <div data-testid="prompt-input" />,
  onModelConfigChange: vi.fn(),
  onEffortChange: vi.fn(),
  onServiceTierChange: vi.fn(),
  onAttachFiles: vi.fn(),
  onSendPrompt: vi.fn(),
  onStop: vi.fn(),
};

function useMobileMediaQuery() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('max-width: 600px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      }) as MediaQueryList
  );
}

afterEach(() => vi.restoreAllMocks());

describe('SimpleSessionFooter', () => {
  it('把模型、速度和显式思考深度放在同一控制栏，不显示对话 Token', () => {
    const onServiceTierChange = vi.fn();
    render(<SimpleSessionFooter {...baseProps} onServiceTierChange={onServiceTierChange} />, {
      wrapper: Wrapper,
    });

    const controls = screen.getByTestId('session-controls');
    expect(screen.getByTestId('model-selector-stub')).toBeInTheDocument();
    expect(screen.getByTestId('effort-bar-control')).toHaveAttribute('title', '思考深度');
    expect(screen.getByTestId('effort-selector-stub')).toHaveTextContent('high');
    expect(screen.queryByTestId('footer-token-count')).not.toBeInTheDocument();
    expect(controls).toContainElement(screen.getByTestId('service-tier-control'));
    expect(screen.getByTestId('service-tier-control')).not.toHaveClass('ant-segmented-sm');

    fireEvent.click(screen.getByRole('radio', { name: /\u5feb\u901f/ }));
    expect(onServiceTierChange).toHaveBeenCalledWith('fast');
  });

  it('没有会话覆盖时显式选中支持列表里的倒数第二档', () => {
    render(
      <SimpleSessionFooter
        {...baseProps}
        effortLevel={undefined}
        toolCaps={{ reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByTestId('effort-selector-stub')).toHaveTextContent('xhigh');
  });

  it('在任务停止中仍保留强制结束入口', () => {
    render(<SimpleSessionFooter {...baseProps} isStopping />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
  });

  it('运行时使用一个状态按钮：空输入停止，有输入则排队', () => {
    const onSendPrompt = vi.fn();
    const { rerender } = render(
      <SimpleSessionFooter {...baseProps} isRunning hasInput={false} onSendPrompt={onSendPrompt} />,
      { wrapper: Wrapper }
    );

    expect(screen.queryByRole('button', { name: '排队消息' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();

    rerender(<SimpleSessionFooter {...baseProps} isRunning hasInput onSendPrompt={onSendPrompt} />);
    fireEvent.click(screen.getByRole('button', { name: '排队消息' }));
    expect(onSendPrompt).toHaveBeenCalledWith('queue');
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
  });

  it('运行中不再显示单独的排队文字和第二个动作按钮', () => {
    const onSendPrompt = vi.fn();
    render(<SimpleSessionFooter {...baseProps} isRunning onSendPrompt={onSendPrompt} />, {
      wrapper: Wrapper,
    });

    expect(screen.queryByText('排队')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择后续消息行为' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '排队消息' }));
    expect(onSendPrompt).toHaveBeenCalledWith('queue');
  });

  it('普通和快速切换先在本地立即更新，再异步保存', () => {
    const onServiceTierChange = vi.fn();
    render(<SimpleSessionFooter {...baseProps} onServiceTierChange={onServiceTierChange} />, {
      wrapper: Wrapper,
    });

    const fast = screen.getByRole('radio', { name: /\u5feb\u901f/ });
    fireEvent.click(fast);

    expect(fast).toBeChecked();
    expect(onServiceTierChange).toHaveBeenCalledTimes(1);
    expect(onServiceTierChange).toHaveBeenCalledWith('fast');
  });

  it('上传期间保留发送按钮，并明确提示会等待附件就绪', () => {
    const { container } = render(
      <SimpleSessionFooter
        {...baseProps}
        composerAttachmentUploading
        composerAttachmentUploadProgress={42}
      />,
      { wrapper: Wrapper }
    );

    const send = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]');
    expect(send).not.toBeNull();
    expect(send).toBeEnabled();
    expect(send?.querySelector('.anticon-send')).toBeInTheDocument();
  });

  it('手机输入区提供模型选择，运行时仍保留停止而不允许排队', () => {
    useMobileMediaQuery();
    render(<SimpleSessionFooter {...baseProps} isRunning hasInput />, { wrapper: Wrapper });

    expect(screen.getByTestId('model-selector-stub')).toHaveAttribute('data-mobile', 'true');
    expect(screen.getByTestId('session-controls')).toContainElement(
      screen.getByTestId('model-selector-stub')
    );
    expect(screen.getByTestId('service-tier-control')).toBeInTheDocument();
    expect(screen.queryByTestId('effort-bar-control')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '排队消息' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
  });

  it('手机显示当前会话的模型，并通过原会话回调保存选择', () => {
    useMobileMediaQuery();
    const onModelConfigChange = vi.fn();
    render(
      <SimpleSessionFooter
        {...baseProps}
        modelConfig={{ mode: 'alias', model: 'gpt-6-astra', effort: 'high' }}
        onModelConfigChange={onModelConfigChange}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByTestId('model-selector-stub')).toHaveTextContent('gpt-6-astra');
    fireEvent.click(screen.getByTestId('model-selector-stub'));
    expect(onModelConfigChange).toHaveBeenCalledExactlyOnceWith({
      mode: 'alias',
      model: 'gpt-6-sol',
      effort: 'high',
    });
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('预设管理的会话模型在手机上仍不可交互', () => {
    useMobileMediaQuery();
    render(
      <SimpleSessionFooter
        {...baseProps}
        session={{ ...session, agentic_tool_preset_id: 'preset-1' }}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByTestId('model-selector-stub').parentElement).toHaveAttribute('inert');
  });

  it('手机把速度切换收进当前档位的下拉菜单，仍即时保存选择', () => {
    useMobileMediaQuery();
    const onServiceTierChange = vi.fn();
    render(<SimpleSessionFooter {...baseProps} onServiceTierChange={onServiceTierChange} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByRole('button', { name: '切换速度，当前普通' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '快速' }));
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith('fast');
    expect(screen.getByRole('button', { name: '切换速度，当前快速' })).toBeInTheDocument();
  });
});
