import type { DiscoClient } from '@disco-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EffortSelector } from './EffortSelector';

describe('EffortSelector', () => {
  it('shows inherited when unset and only offers supported levels', () => {
    render(
      <EffortSelector
        allowInherited
        levels={['low', 'medium', 'high', 'xhigh']}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('Inherited')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('X-High')).toBeInTheDocument();
    expect(within(listbox).queryByText('Maximum')).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/default/i)).not.toBeInTheDocument();
  });

  it('uses the caller-provided fallback instead of owning a default', () => {
    render(<EffortSelector fallbackValue="medium" levels={['low', 'medium', 'high']} />);
    expect(screen.getByRole('combobox').parentElement).toHaveTextContent('Medium effort');
  });

  it('clears an explicit override back to inherited', () => {
    const onChange = vi.fn();
    const { container } = render(
      <EffortSelector
        value="medium"
        allowInherited
        levels={['low', 'medium', 'high', 'xhigh']}
        onChange={onChange}
      />
    );

    const select = container.querySelector('.ant-select') as Element;
    fireEvent.mouseEnter(select);
    fireEvent.mouseDown(container.querySelector('.ant-select-clear') as Element);
    expect(onChange.mock.calls.at(-1)?.[0]).toBeUndefined();
  });

  it('keeps an unsupported saved effort until the user explicitly replaces it', async () => {
    const find = vi.fn().mockResolvedValue({
      source: 'dynamic',
      default: 'new-model',
      models: [
        {
          id: 'new-model',
          displayName: 'New model',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: ['medium', 'high'],
          defaultReasoningEffort: 'medium',
        },
      ],
    });
    const client = { service: () => ({ find }) } as unknown as DiscoClient;
    const onChange = vi.fn();
    const { container } = render(
      <EffortSelector client={client} codexModel="new-model" value="max" onChange={onChange} />
    );
    expect(await screen.findByText(/原设置已保留/)).toBeInTheDocument();
    expect(screen.getByRole('combobox').parentElement).toHaveTextContent('Max effort');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(
      container.ownerDocument.querySelector('.ant-select-item-option-disabled')
    ).toHaveTextContent('Max');
    fireEvent.click(screen.getByRole('button', { name: '更换为 medium' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('medium');
  });
});
