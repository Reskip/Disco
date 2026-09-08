// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify theme-token propagation
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { InitialLoadingScreen } from './InitialLoadingScreen';

const lightTheme = {
  token: {
    colorBgLayout: '#fafafa',
    colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
  },
};

describe('InitialLoadingScreen', () => {
  it('uses Ant Design theme tokens for the page background in light mode', () => {
    const { container } = render(
      <ConfigProvider theme={lightTheme}>
        <InitialLoadingScreen message="Loading…" />
      </ConfigProvider>
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveStyle({ backgroundColor: '#fafafa' });
  });

  it('renders a compact Chinese progress state without legacy organization labels', () => {
    render(
      <ConfigProvider theme={lightTheme}>
        <InitialLoadingScreen
          items={[
            { key: 'sessions', label: 'Sessions', done: true, count: 2 },
            { key: 'boards', label: 'Boards', done: false, count: 0 },
          ]}
        />
      </ConfigProvider>
    );

    expect(screen.getByText('正在加载工作区…')).toBeInTheDocument();
    expect(screen.getByText('已完成 1/2')).toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
    expect(screen.queryByText('Boards')).not.toBeInTheDocument();
  });

  it('does not expose secondary backend resource names', () => {
    render(
      <ConfigProvider theme={lightTheme}>
        <InitialLoadingScreen
          items={[
            { key: 'sessions', label: 'Sessions', done: true, count: 2 },
            { key: 'board-objects', label: 'Board objects', done: false, count: 4 },
            { key: 'artifacts', label: 'Artifacts', done: true, count: 1 },
          ]}
        />
      </ConfigProvider>
    );

    expect(screen.getByText('已完成 2/3')).toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
    expect(screen.queryByText('Board objects')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
  });
});
