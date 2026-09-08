import { describe, expect } from 'vitest';
import { bootstrapFirstRunAdmin } from './first-run-bootstrap';
import { dbTest } from './test-helpers';
import { createUser } from './user-utils';

describe('bootstrapFirstRunAdmin', () => {
  dbTest('allows competing daemon admin bootstraps to converge on one user', async ({ db }) => {
    const createAdmin = () =>
      createUser(db, {
        username: 'admin',
        password: 'concurrent-bootstrap-password',
        role: 'superadmin',
      });

    const results = await Promise.all([
      bootstrapFirstRunAdmin(db, createAdmin),
      bootstrapFirstRunAdmin(db, createAdmin),
    ]);

    expect(results.filter((result) => result.createdAdmin)).toHaveLength(1);
    expect(new Set(results.map((result) => result.admin?.user_id)).size).toBe(1);
  });

  dbTest('prefers an existing superadmin without creating another account', async ({ db }) => {
    const member = await createUser(db, {
      username: 'member@example.com',
      password: 'member-password',
      role: 'member',
    });
    const superadmin = await createUser(db, {
      username: 'superadmin@example.com',
      password: 'superadmin-password',
      role: 'superadmin',
    });
    const result = await bootstrapFirstRunAdmin(db, async () => {
      throw new Error('should not create an admin when users already exist');
    });

    expect(result.createdAdmin).toBe(false);
    expect(result.admin?.user_id).toBe(superadmin.user_id);
    expect(result.admin?.user_id).not.toBe(member.user_id);
    expect(result.reattributedCount).toBe(0);
  });
});
