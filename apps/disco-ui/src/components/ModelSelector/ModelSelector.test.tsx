import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { ModelSelector } from './ModelSelector';

describe('ModelSelector (Claude)', () => {
  it('renders aliases by display name and offers a pin affordance', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    // Closed control shows the friendly display name, not the raw id.
    expect(screen.getByText('Claude Sonnet 5 — 1M')).toBeInTheDocument();
    expect(screen.getByText('锁定具体版本…')).toBeInTheDocument();
  });

  it('re-hydrates an exact/pinned model ID into the pin input', () => {
    const pinned = 'claude-sonnet-4-6-20260101';
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: pinned }}
      />
    );
    // Pinned view is active: the exact id is editable and the alias link flips.
    expect(screen.getByRole('combobox')).toHaveValue(pinned);
    expect(screen.getByText('使用推荐模型')).toBeInTheDocument();
    expect(screen.queryByText('锁定具体版本…')).not.toBeInTheDocument();
  });

  it('updates pin mode when a controlled value changes', () => {
    const pinned = 'claude-sonnet-4-6-20260101';
    const { rerender } = render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );

    rerender(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: pinned }}
      />
    );

    expect(screen.getByRole('combobox')).toHaveValue(pinned);
    expect(screen.getByText('使用推荐模型')).toBeInTheDocument();
  });

  it('switches to exact mode only after a specific version is entered', () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onChange={onChange}
      />
    );
    const pinButton = screen.getByRole('button', { name: '锁定具体版本…' });
    pinButton.focus();
    expect(pinButton).toHaveFocus();
    fireEvent.click(pinButton);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'claude-sonnet-4-6-20260101' },
    });
    expect(onChange).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-4-6-20260101',
    });
  });

  it('wraps option descriptions instead of truncating them', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    // A long model description renders in full and is allowed to wrap.
    expect(screen.getByText(/Frontier model for complex reasoning/)).toHaveStyle({
      whiteSpace: 'normal',
    });
  });

  it('offers previous aliases alongside the preferred models', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));

    expect(screen.getByText('Claude Opus 4.7 — 200k')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4.7 — 1M')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4.6 — 200k')).toBeInTheDocument();
  });
});

describe('ModelSelector (Codex)', () => {
  it('marks older aliases whose availability depends on the provider account', () => {
    render(<ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-5.6-sol' }} />);

    fireEvent.mouseDown(screen.getByRole('combobox'));

    expect(screen.getAllByText('account-dependent').length).toBeGreaterThan(0);
  });

  it('在中文界面本地化推荐标记、说明和可用性标签', () => {
    render(
      <LocaleProvider>
        <ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-5.6-sol' }} />
      </LocaleProvider>
    );

    expect(screen.getByText('GPT-5.6 Sol（推荐）')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getByText('适合复杂、开放式工作的 GPT-5.6 旗舰模型')).toBeInTheDocument();
    expect(screen.getAllByText('账号相关').length).toBeGreaterThan(0);
    expect(screen.getByText('默认')).toBeInTheDocument();
  });

  it('提供 GPT-6 Astra 并标明账号可用性', () => {
    render(
      <LocaleProvider>
        <ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-6-astra' }} />
      </LocaleProvider>
    );

    expect(screen.getByText('GPT-6 Astra')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getByText('支持 105 万上下文与高级工具调用的 GPT-6 旗舰 Codex 模型')).toBeInTheDocument();
    expect(screen.getAllByText('账号相关').length).toBeGreaterThan(0);
  });
});
