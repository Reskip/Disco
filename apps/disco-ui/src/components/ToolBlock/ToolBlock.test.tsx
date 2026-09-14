// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify semantic tool states
import { CloseCircleOutlined } from '@ant-design/icons';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ToolBlock } from './ToolBlock';

describe('ToolBlock', () => {
  it('does no hidden renderer work, releases closed details and reopens with current output', async () => {
    const mounted = vi.fn();
    const released = vi.fn();
    function Output({ value }: { value: string }) {
      useEffect(() => {
        mounted();
        return released;
      }, []);
      return <pre data-testid="tool-output">{value}</pre>;
    }
    const view = (value: string) => (
      <ConfigProvider>
        <ToolBlock icon={null} name="Bash">
          <Output value={value} />
        </ToolBlock>
      </ConfigProvider>
    );
    const { rerender } = render(view('first output'));
    const toggle = () => fireEvent.click(screen.getByText('Bash'));
    expect(mounted).not.toHaveBeenCalled();
    toggle();
    expect(screen.getByTestId('tool-output').textContent).toBe('first output');
    toggle();
    await waitFor(() => expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument());
    expect(released).toHaveBeenCalledTimes(1);
    rerender(view('latest output'));
    expect(mounted).toHaveBeenCalledTimes(1);
    toggle();
    expect(screen.getByTestId('tool-output').textContent).toBe('latest output');
  });

  it('keeps default-expanded content and cancels release when quickly reopened', async () => {
    render(
      <ConfigProvider>
        <ToolBlock icon={null} name="Write" expandedByDefault>
          <pre data-testid="written-file">complete file</pre>
        </ToolBlock>
      </ConfigProvider>
    );
    const content = screen.getByTestId('written-file');
    fireEvent.click(screen.getByText('Write'));
    fireEvent.click(screen.getByText('Write'));
    // Give any stale close timer time to fire, then verify the same subtree survived.
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(screen.getByTestId('written-file')).toBe(content);
  });

  it('renders failed tool-call status icons with the warning tone', () => {
    render(
      <ConfigProvider
        theme={{
          token: {
            colorError: 'rgb(255, 0, 0)',
            colorWarning: 'rgb(255, 170, 0)',
          },
        }}
      >
        <ToolBlock
          icon={<CloseCircleOutlined data-testid="tool-failure-icon" />}
          name="Bash"
          status="error"
        />
      </ConfigProvider>
    );

    const statusIconWrapper = screen.getByTestId('tool-failure-icon').parentElement as HTMLElement;

    expect(statusIconWrapper).toHaveStyle({ color: 'rgb(255, 170, 0)' });
    expect(statusIconWrapper).not.toHaveStyle({ color: 'rgb(255, 0, 0)' });
  });
});
