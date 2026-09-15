import type { DiscoClient } from '@disco-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolBlock } from '../ToolBlock';
import { ToolUseRenderer } from './ToolUseRenderer';

const toolUse = {
  type: 'tool_use' as const,
  id: 'call-1',
  name: 'custom',
  input: {},
  deferred: { message_id: 'm1', block_index: 0 },
};
const toolResult = {
  type: 'tool_result' as const,
  tool_use_id: 'call-1',
  content: '',
  deferred: { message_id: 'm1', block_index: 1 },
};
const original = {
  content: [
    { type: 'tool_use', id: 'call-1', name: 'custom', input: { code: '完整代码' } },
    { type: 'tool_result', tool_use_id: 'call-1', content: '完整输出' },
  ],
};

describe('deferred tool details', () => {
  it('requests no payload while collapsed, then resolves both blocks with one authorized get', async () => {
    const get = vi.fn().mockResolvedValue(original);
    const client = { service: () => ({ get }) } as unknown as DiscoClient;
    render(
      <ToolBlock icon={null} name="修改文件">
        <ToolUseRenderer client={client} toolUse={toolUse} toolResult={toolResult} compact />
      </ToolBlock>
    );
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('修改文件'));
    expect(await screen.findByText('完整输出')).toBeInTheDocument();
    expect(screen.getByText(/完整代码/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledExactlyOnceWith('m1');
  });

  it('shows a recoverable error instead of an endless spinner', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(original);
    const client = { service: () => ({ get }) } as unknown as DiscoClient;
    render(<ToolUseRenderer client={client} toolUse={toolUse} toolResult={toolResult} compact />);
    expect(await screen.findByText('工具详情加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByText('完整输出')).toBeInTheDocument();
  });

  it('discards a response from the previous account/client', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldClient = {
      service: () => ({
        get: () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      }),
    } as unknown as DiscoClient;
    const newGet = vi.fn().mockRejectedValue(new Error('forbidden'));
    const newClient = { service: () => ({ get: newGet }) } as unknown as DiscoClient;
    const props = { toolUse, toolResult, compact: true };
    const { rerender } = render(<ToolUseRenderer {...props} client={oldClient} />);
    rerender(<ToolUseRenderer {...props} client={newClient} />);
    await act(async () => {
      resolveOld(original);
    });
    await waitFor(() => expect(screen.getByText('工具详情加载失败')).toBeInTheDocument());
    expect(screen.queryByText('完整输出')).not.toBeInTheDocument();
  });
});
