import type { UserID } from '@disco/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

dbTest(
  'persists storage retention independently for each user and rejects unsafe values',
  async ({ db }) => {
    const service = new UsersService(db);
    const first = await service.create({
      username: `storage-${Math.random().toString(36).slice(2)}`,
      password: 'storage-password',
    });
    const second = await service.create({
      username: `storage-${Math.random().toString(36).slice(2)}`,
      password: 'storage-password',
    });
    const id = first.user_id as UserID;
    await service.patch(id, {
      preferences: { audio: { enabled: true }, storage: { intermediateRetentionDays: 30 } },
    });
    expect((await service.get(id)).preferences).toMatchObject({
      audio: { enabled: true },
      storage: { intermediateRetentionDays: 30 },
    });
    expect((await service.get(second.user_id as UserID)).preferences?.storage).toBeUndefined();
    for (const value of [-1, 1.5, 3651, '7', null]) {
      await expect(
        service.patch(id, { preferences: { storage: { intermediateRetentionDays: value } } })
      ).rejects.toThrow('保留天数');
    }
    expect((await service.get(id)).preferences?.storage?.intermediateRetentionDays).toBe(30);
    await service.patch(id, { preferences: { storage: { intermediateRetentionDays: 0 } } });
    expect((await service.get(id)).preferences?.storage?.intermediateRetentionDays).toBe(0);
  }
);
