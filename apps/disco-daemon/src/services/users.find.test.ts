import { AuthenticationService, feathers } from '@disco/core/feathers';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { authorizeUsersGet } from '../register-hooks';
import { DiscoLocalStrategy } from '../register-routes';
import { createUsersService, LOCAL_AUTH_LOOKUP_PARAM, UsersService } from './users';

describe('UsersService.find', () => {
  dbTest('stores normalized local usernames', async ({ db }) => {
    const service = new UsersService(db);

    const created = await service.create({
      username: ' FamilyAdmin ',
      password: 'password-123',
      name: '家庭管理员',
    });
    const unicode = await service.create({
      username: '小明',
      password: 'password-123',
      name: '小明',
    });

    expect(created.username).toBe('familyadmin');
    expect(unicode.username).toBe('小明');
    await expect(service.create({ username: 'a b', password: 'password-123' })).rejects.toThrow(
      /letters, numbers, dots, underscores, or hyphens/
    );
    await expect(
      service.create({ username: 'person@example.com', password: 'password-123' })
    ).rejects.toThrow(/letters, numbers, dots, underscores, or hyphens/);
  });

  dbTest('rejects case-insensitive username collisions on create and rename', async ({ db }) => {
    const service = new UsersService(db);
    const first = await service.create({ username: 'familyuser', password: 'password-123' });
    const second = await service.create({ username: 'otheruser', password: 'password-123' });

    await expect(
      service.create({ username: 'FamilyUser', password: 'password-123' })
    ).rejects.toThrow(/already in use/);
    await expect(service.patch(second.user_id, { username: ' FAMILYUSER ' })).rejects.toThrow(
      /already in use/
    );
    await expect(service.patch(first.user_id, { username: 'FamilyUser' })).resolves.toMatchObject({
      username: 'familyuser',
    });
  });

  dbTest('respects limit/skip pagination and reports total matches', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ username: 'alpha', password: 'password-123', name: 'Alpha' });
    await service.create({ username: 'bravo', password: 'password-123', name: 'Bravo' });
    await service.create({
      username: 'charlie',
      password: 'password-123',
      name: 'Charlie',
    });

    const page = await service.find({ query: { $limit: 1, $skip: 1 } });

    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].username).toBe('bravo');
  });

  dbTest('ignores tenant scope safely on SQLite users table', async ({ db }) => {
    const service = new UsersService(db);

    const created = await service.create(
      { username: 'tenant-safe', password: 'password-123', name: 'Tenant Safe' },
      { tenant: { tenant_id: 'default', source: 'static' } } as never
    );

    const page = await service.find({
      tenant: { tenant_id: 'default', source: 'static' },
      query: { $limit: 10 },
    } as never);
    const fetched = await service.get(created.user_id, {
      tenant: { tenant_id: 'default', source: 'static' },
    } as never);

    expect(page.data.map((user) => user.username)).toContain('tenant-safe');
    expect(fetched.username).toBe('tenant-safe');
  });

  dbTest('supports offset alias for pagination', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ username: 'alpha', password: 'password-123', name: 'Alpha' });
    await service.create({ username: 'bravo', password: 'password-123', name: 'Bravo' });

    const page = await service.find({ query: { limit: 1, offset: 1 } });

    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data.map((user) => user.username)).toEqual(['bravo']);
  });

  dbTest(
    'searches name/username/unix_username case-insensitively before pagination',
    async ({ db }) => {
      const service = new UsersService(db);

      await service.create({
        username: 'reed',
        password: 'password-123',
        name: 'Reed Thompson',
        unix_username: 'rthompson',
      });
      await service.create({
        username: 'someone',
        password: 'password-123',
        name: 'Someone Else',
        unix_username: 'someone',
      });

      const byName = await service.find({ query: { search: 'REED', $limit: 10 } });
      expect(byName.total).toBe(1);
      expect(byName.data[0].username).toBe('reed');

      const byUsername = await service.find({ query: { q: 'REED', $limit: 10 } });
      expect(byUsername.total).toBe(1);
      expect(byUsername.data[0].name).toBe('Reed Thompson');

      const byUnix = await service.find({ query: { query: 'THOMP', $limit: 10 } });
      expect(byUnix.total).toBe(1);
      expect(byUnix.data[0].unix_username).toBe('rthompson');
    }
  );
});

describe('UsersService.find exact-username hardening', () => {
  dbTest('rejects unauthenticated external exact-username lookup', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ username: 'target', password: 'password-123' });

    await expect(
      service.find({ provider: 'rest', query: { username: 'target' } })
    ).rejects.toThrow(/Authentication required/);
  });

  dbTest('rejects authenticated non-admin lookup for another username', async ({ db }) => {
    const service = new UsersService(db);
    const requester = await service.create({
      username: 'requester',
      password: 'password-123',
    });
    await service.create({ username: 'target', password: 'password-123' });

    await expect(
      service.find({
        provider: 'rest',
        user: { user_id: requester.user_id, username: requester.username, role: 'member' },
        query: { username: 'target' },
      })
    ).rejects.toThrow(/Exact username lookup is restricted/);
  });

  dbTest('allows self exact-username lookup without exposing password', async ({ db }) => {
    const service = new UsersService(db);
    const user = await service.create({ username: 'self', password: 'password-123' });

    const page = await service.find({
      provider: 'rest',
      user: { user_id: user.user_id, username: user.username, role: 'member' },
      query: { username: 'self' },
    });

    expect(page.total).toBe(1);
    expect(page.data[0].username).toBe('self');
    expect(page.data[0]).not.toHaveProperty('password');
  });

  dbTest('allows admin exact-username lookup without exposing password', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ username: 'target', password: 'password-123' });

    const page = await service.find({
      provider: 'rest',
      user: { user_id: 'admin-user', username: 'admin', role: 'admin' },
      query: { username: 'target' },
    });

    expect(page.total).toBe(1);
    expect(page.data[0].username).toBe('target');
    expect(page.data[0]).not.toHaveProperty('password');
  });

  dbTest('keeps password hash scoped to the local authentication pipeline', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ username: 'login-user', password: 'password-123' });

    const externalSelf = await service.find({
      provider: 'rest',
      user: { user_id: 'login-user', username: 'login-user', role: 'member' },
      query: { username: 'login-user' },
    });
    expect(externalSelf.data[0]).not.toHaveProperty('password');

    const authLookup = await service.find({
      provider: 'rest',
      [LOCAL_AUTH_LOOKUP_PARAM]: true,
      query: { username: 'login-user' },
    } as any);
    expect(authLookup.data[0]).toHaveProperty('password');
  });

  dbTest('local authentication succeeds through the registered strategy marker', async ({ db }) => {
    const app = feathers();
    app.set('authentication', {
      secret: 'test-jwt-secret',
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['local'],
      jwtOptions: {
        header: { typ: 'access' },
        audience: 'https://disco.dev',
        issuer: 'disco',
        algorithm: 'HS256',
        expiresIn: '15m',
      },
      local: {
        usernameField: 'username',
        passwordField: 'password',
      },
    });

    app.use('users', createUsersService(db));
    app.service('users').hooks({ before: { get: [authorizeUsersGet] } });

    const authentication = new AuthenticationService(app);
    authentication.register('local', new DiscoLocalStrategy());
    app.use('authentication', authentication);

    await app.service('users').create({
      username: 'strategy-login',
      password: 'password-123',
      role: 'viewer',
    });

    const result = await app.service('authentication').create(
      {
        strategy: 'local',
        username: 'strategy-login',
        password: 'password-123',
      },
      { provider: 'rest' }
    );

    expect(result.user.username).toBe('strategy-login');
    expect(result.user.role).toBe('viewer');
    expect(result.user).not.toHaveProperty('password');

    await expect(
      app.service('authentication').create(
        {
          strategy: 'local',
          username: 'missing-user',
          password: 'password-123',
        },
        { provider: 'rest' }
      )
    ).rejects.toMatchObject({
      message: '用户名不存在',
      data: { code: 'USERNAME_NOT_FOUND' },
    });

    await expect(
      app.service('authentication').create(
        {
          strategy: 'local',
          username: 'strategy-login',
          password: 'definitely-wrong',
        },
        { provider: 'rest' }
      )
    ).rejects.toMatchObject({
      message: '密码错误',
      data: { code: 'PASSWORD_INCORRECT' },
    });
  });
});
