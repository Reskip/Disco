import type { LeaderboardEntry } from '@disco-live/client';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { HomeTokenUsageCard } from './HomeTokenUsageCard';

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    totalTokens: 1_000_000,
    totalInputTokens: 800_000,
    totalOutputTokens: 200_000,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    taskCount: 1,
    sessionCount: 1,
    totalDurationMs: 100,
    ...overrides,
  };
}

function makeClient() {
  const allTimeModels = [
    entry({ model: 'gpt-5.6-sol' }),
    entry({ model: 'gpt-5.6-luna', totalTokens: 250_000, totalInputTokens: 200_000 }),
    entry({ model: '', totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }),
  ];
  const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    if (query.groupBy === 'model') {
      return { data: query.startDate ? [entry({ model: 'period-only-model' })] : allTimeModels };
    }
    if (query.groupBy === 'user,model') {
      return {
        data: [
          entry({
            userId: 'user-1',
            userName: '用户一',
            model: 'gpt-5.6-sol',
          }),
        ],
      };
    }
    if (query.groupBy === '' && !query.bucket) {
      return { data: [entry({ userId: 'user-1' })] };
    }
    return { data: [] };
  });
  return { service: () => ({ find }) } as never;
}

describe('HomeTokenUsageCard layout', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('places the all-time model ranking beside history and user ranking before realtime', async () => {
    render(
      <LocaleProvider>
        <HomeTokenUsageCard client={makeClient()} connected currentUserId="user-1" />
      </LocaleProvider>
    );

    await waitFor(() => expect(screen.getByText('gpt-5.6-sol')).toBeInTheDocument());

    expect(screen.getByText('按模型统计')).toBeInTheDocument();
    const modelRows = screen.getAllByTestId('token-model-row');
    expect(modelRows).toHaveLength(2);
    expect(modelRows[0]).toHaveAttribute('data-model-key', 'gpt-5.6-sol');
    expect(modelRows[1]).toHaveAttribute('data-model-key', 'gpt-5.6-luna');
    expect(screen.getAllByTestId('token-model-bar-fill')).toHaveLength(2);
    expect(screen.queryByText('period-only-model')).not.toBeInTheDocument();

    const history = screen.getByTestId('token-history-card');
    const models = screen.getByTestId('token-model-card');
    expect(within(models).queryByText('按 Token 用量排序')).not.toBeInTheDocument();
    expect(history.parentElement).toHaveClass('disco-token-history-model-grid');
    expect(history.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const realtime = screen.getByTestId('token-realtime-card');
    const users = screen.getByTestId('token-user-ranking-card');
    expect(users.compareDocumentPosition(realtime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
