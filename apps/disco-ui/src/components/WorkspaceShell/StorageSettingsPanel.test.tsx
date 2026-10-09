import type { DiscoClient, UpdateUserInput, User } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StorageSettingsPanel } from './StorageSettingsPanel';

const user = { user_id: 'owner', preferences: { audio: { enabled: true } } } as User;
describe('storage retention settings', () => {
  it('saves a per-user window while preserving the latest unrelated preferences', async () => {
    const latest = {
      ...user,
      preferences: { ...user.preferences, tokenPricing: { cnyPerUsd: 7 } },
    };
    const client = {
      service: () => ({ get: vi.fn(async () => latest) }),
    } as unknown as DiscoClient;
    const onUpdateUser = vi.fn(async (_id: string, _updates: UpdateUserInput) => {});
    function RealtimeAccount() {
      const [current, setCurrent] = useState(user);
      return (
        <StorageSettingsPanel
          currentUser={current}
          client={client}
          onUpdateUser={async (id, updates: UpdateUserInput) => {
            await onUpdateUser(id, updates);
            setCurrent({ ...current, ...updates } as User);
          }}
        />
      );
    }
    render(<RealtimeAccount />);
    expect(screen.getByText('7 天')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '临时文件与缓存保留时间' }));
    fireEvent.click(await screen.findByText('30 天'));
    fireEvent.click(screen.getByRole('button', { name: '保存存储设置' }));
    await waitFor(() =>
      expect(onUpdateUser).toHaveBeenCalledWith('owner', {
        preferences: {
          ...latest.preferences,
          storage: { intermediateRetentionDays: 30 },
        },
      })
    );
    expect(await screen.findByText('存储设置已保存')).toBeInTheDocument();
  });
  it('restores disabling cleanup and does not overwrite preferences after a failed reload', async () => {
    const currentUser = { ...user, preferences: { storage: { intermediateRetentionDays: 0 } } };
    const onUpdateUser = vi.fn();
    const client = {
      service: () => ({
        get: async () => {
          throw new Error('连接失败');
        },
      }),
    } as unknown as DiscoClient;
    render(
      <StorageSettingsPanel currentUser={currentUser} client={client} onUpdateUser={onUpdateUser} />
    );
    expect(screen.getByText('不自动清理')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存存储设置' }));
    expect(await screen.findByText('连接失败')).toBeInTheDocument();
    expect(onUpdateUser).not.toHaveBeenCalled();
    expect(screen.queryByText('存储设置已保存')).not.toBeInTheDocument();
  });
});
