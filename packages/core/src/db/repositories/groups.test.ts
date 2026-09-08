import type { UserID } from '@disco/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { GroupRepository } from './groups';
import { UsersRepository } from './users';

async function makeUser(repo: UsersRepository, username: string): Promise<UserID> {
  const user = await repo.create({ username, name: username, role: 'member' });
  return user.user_id as UserID;
}

describe('GroupRepository', () => {
  dbTest('creates, updates, archives and deletes an admin-managed group', async ({ db }) => {
    const users = new UsersRepository(db);
    const groups = new GroupRepository(db);
    const ownerId = await makeUser(users, 'group-owner@example.com');

    const group = await groups.create({
      name: 'Research Team',
      description: 'Shared account administration group',
      created_by: ownerId,
    });
    expect(group.slug).toBe('research-team');
    expect(await groups.findBySlug('research-team')).toMatchObject({ group_id: group.group_id });

    const updated = await groups.update(group.group_id, {
      name: 'Research Operators',
      archived: true,
    });
    expect(updated).toMatchObject({ name: 'Research Operators', archived: true });
    expect(await groups.findAll({ archived: true })).toHaveLength(1);

    await expect(groups.delete(group.group_id)).resolves.toMatchObject({ group_id: group.group_id });
    await expect(groups.findById(group.group_id)).resolves.toBeNull();
  });

  dbTest('manages idempotent user membership without granting resource visibility', async ({ db }) => {
    const users = new UsersRepository(db);
    const groups = new GroupRepository(db);
    const ownerId = await makeUser(users, 'membership-owner@example.com');
    const memberId = await makeUser(users, 'membership-member@example.com');
    const group = await groups.create({ name: 'Family', created_by: ownerId });

    const first = await groups.addMember(group.group_id, memberId, ownerId);
    const second = await groups.addMember(group.group_id, memberId, ownerId);
    expect(second).toEqual(first);
    expect(await groups.getGroupIdsForUser(memberId)).toEqual([group.group_id]);
    expect(await groups.listMemberships({ group_id: group.group_id })).toHaveLength(1);

    await expect(groups.removeMember(group.group_id, memberId)).resolves.toMatchObject({
      user_id: memberId,
    });
    await expect(groups.removeMember(group.group_id, memberId)).resolves.toBeNull();
  });
});
