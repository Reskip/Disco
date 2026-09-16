import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeQuotaBar } from './HomeQuotaBar';

const ready = { status: 'ready', remainingPercent: 17, resetsAt: '2026-09-19T08:10:00.000Z' };
const client = (find: () => Promise<unknown>) => ({ service: () => ({ find }) }) as never;
afterEach(() => vi.useRealTimers());

describe('home primary quota strip', () => {
  it('renders the approved single quota with a Beijing reset time and no extra controls', async () => {
    render(<HomeQuotaBar client={client(async () => ready)} connected currentUserId="user-a" />);
    await screen.findByText('17');
    expect(screen.getByText('9 月 19 日 16:10 重置')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Pro|Spark|7 天周期|更新于|宿主机|可用额度重置/)
    ).not.toBeInTheDocument();
  });
  it('does not turn a missing value into 0% or block other home content', async () => {
    const result = { status: 'unavailable', remainingPercent: null, resetsAt: null };
    render(
      <>
        <HomeQuotaBar client={client(async () => result)} connected currentUserId="user-a" />
        <p>首页内容</p>
      </>
    );
    expect(screen.getByText('首页内容')).toBeInTheDocument();
    await screen.findByText('暂无数据');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
  it('ignores a late reply after the client or account changes', async () => {
    let resolveOld!: (result: unknown) => void;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const { rerender } = render(
      <HomeQuotaBar client={client(() => old)} connected currentUserId="a" />
    );
    rerender(
      <HomeQuotaBar
        client={client(async () => ({ ...ready, remainingPercent: 42 }))}
        connected
        currentUserId="b"
      />
    );
    await screen.findByText('42');
    await act(async () => resolveOld(ready));
    expect(screen.queryByText('17')).not.toBeInTheDocument();
  });
  it('refreshes once per minute and clears stale data on a failed refresh', async () => {
    vi.useFakeTimers();
    const find = vi.fn().mockResolvedValueOnce(ready).mockRejectedValue(new Error('offline'));
    render(<HomeQuotaBar client={client(find)} connected currentUserId="user-a" />);
    await act(async () => {});
    expect(screen.getByText('17')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(find).toHaveBeenCalledTimes(2);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(screen.queryByText('17')).not.toBeInTheDocument();
  });
});
