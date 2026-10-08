import type { DiscoClient } from '@disco-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('shows plain model names without descriptions or recommendation, account or default badges', () => {
    render(
      <LocaleProvider>
        <ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-5.6-sol' }} />
      </LocaleProvider>
    );
    expect(screen.getByText('GPT-5.6 Sol')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.queryByText('默认')).not.toBeInTheDocument();
    expect(screen.queryByText('账号相关')).not.toBeInTheDocument();
    expect(screen.queryByText(/（推荐）|Recommended|account-dependent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/旗舰|Frontier|workhorse/)).not.toBeInTheDocument();
  });

  const catalog = {
    source: 'dynamic',
    default: 'new-model',
    models: [
      {
        id: 'new-model',
        displayName: 'New model',
        description: 'A provider supplied English description',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
      },
      { id: 'old-hidden', displayName: 'Hidden', hidden: true, isDefault: false },
    ],
  };
  it('waits for initial discovery before showing selectable fallback models', async () => {
    let finish!: (value: typeof catalog) => void;
    const find = vi.fn(() => new Promise<typeof catalog>((resolve) => (finish = resolve)));
    const client = { service: () => ({ find }) } as unknown as DiscoClient;
    render(
      <ModelSelector
        agentic_tool="codex"
        client={client}
        value={{ mode: 'alias', model: 'gpt-6-astra' }}
      />
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getByText('正在获取模型列表…')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.6 Sol')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新列表' })).not.toBeInTheDocument();
    await waitFor(() => expect(find).toHaveBeenCalledOnce());
    await act(async () => finish(catalog));
    expect(await screen.findByText('New model')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.6 Sol')).not.toBeInTheDocument();
  });
  it('loads new models, preserves an absent default and replaces it only on an explicit click', async () => {
    const find = vi.fn().mockResolvedValue(catalog);
    const onChange = vi.fn();
    const client = { service: () => ({ find }) } as unknown as DiscoClient;
    render(
      <ModelSelector
        agentic_tool="codex"
        compact
        client={client}
        onChange={onChange}
        value={{ mode: 'alias', model: 'removed-model' }}
      />
    );
    expect(await screen.findByText(/原设置已保留/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('removed-model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更换为 New model' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'alias', model: 'new-model', effort: 'medium' });
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getAllByText('New model').length).toBeGreaterThan(0);
    expect(screen.queryByText('A provider supplied English description')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5.6 Sol')).not.toBeInTheDocument();
  });
  it('does not classify discovery failure or an exact ID as an unavailable selection', async () => {
    const find = vi.fn().mockRejectedValue(new Error('offline'));
    const onChange = vi.fn();
    const client = { service: () => ({ find }) } as unknown as DiscoClient;
    render(
      <ModelSelector
        agentic_tool="codex"
        client={client}
        onChange={onChange}
        value={{ mode: 'exact', model: 'my-pinned-model' }}
      />
    );
    await waitFor(() => expect(screen.getByText(/暂时无法更新模型列表/)).toBeInTheDocument());
    expect(screen.queryByText(/已不再提供/)).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
