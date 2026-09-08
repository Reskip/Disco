/**
 * Defence-in-depth tests for UsersService env-var ingest.
 *
 * GITHUB_TOKEN / GH_TOKEN end up interpolated into a clone URL (and at one
 * point into a shell-form git credential helper). Any value that does not
 * match the `isLikelyGitToken` shape must be rejected at ingest so attacker-
 * shaped bytes cannot persist in the database.
 */

import { AgenticToolPresetRepository } from '@disco/core/db';
import type { UserID } from '@disco/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

async function makeUser(service: UsersService): Promise<UserID> {
  const user = await service.create({
    username: `sec-${Math.random().toString(36).slice(2)}`,
    password: 'test-password-1234',
  });
  return user.user_id as UserID;
}

describe('UsersService — git token env var hardening', () => {
  dbTest('rejects GITHUB_TOKEN with shell metacharacters', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc;rm -rf /' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with newline', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc\nmore' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with command substitution', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc$(whoami)' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN that is too short', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'short' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GH_TOKEN with the same shape check', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GH_TOKEN: 'abc;id' },
      })
    ).rejects.toThrow(/Invalid GH_TOKEN/);
  });

  dbTest('accepts a well-formed GitHub PAT', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` },
      })
    ).resolves.toBeDefined();
  });
});

describe('UsersService — delegated execution home key validation', () => {
  for (const invalid of ['1alice', '-alice', 'Alice', '../alice', 'alice name', 'a'.repeat(33)]) {
    dbTest(`rejects invalid key ${JSON.stringify(invalid)} on create`, async ({ db }) => {
      const service = new UsersService(db);
      await expect(
        service.create({
          username: `invalid-${Math.random().toString(36).slice(2)}`,
          password: 'test-password-1234',
          unix_username: invalid,
        })
      ).rejects.toThrow(/Execution home key/);
    });

    dbTest(`rejects invalid key ${JSON.stringify(invalid)} on patch`, async ({ db }) => {
      const service = new UsersService(db);
      const id = await makeUser(service);
      await expect(service.patch(id, { unix_username: invalid })).rejects.toThrow(
        /Execution home key/
      );
    });
  }

  dbTest('accepts the canonical delegated key syntax', async ({ db }) => {
    const service = new UsersService(db);
    const user = await service.create({
      username: 'valid-home-key',
      password: 'test-password-1234',
      unix_username: '_alice-1',
    });
    expect(user.unix_username).toBe('_alice-1');
  });
});

describe('UsersService — avatar metadata', () => {
  dbTest(
    'marks explicit avatar URL patches as manual and clears stale source metadata',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        username: 'avatar-source',
        password: 'test-password-1234',
        avatar_url: 'https://legacy.example.com/avatar-512.png',
        avatar_source: 'legacy-import',
        avatar_source_id: 'legacy-123',
        avatar_synced_at: '2026-06-24T00:00:00.000Z',
      });

      const updated = await service.patch(user.user_id as UserID, {
        avatar_url: 'https://cdn.example.com/manual.png',
      });

      expect(updated.avatar_url).toBe('https://cdn.example.com/manual.png');
      expect(updated.avatar_source).toBe('manual');
      expect(updated.avatar_source_id).toBeUndefined();
      expect(updated.avatar_synced_at).toBeUndefined();
    }
  );

  dbTest(
    'clears stale source metadata when avatar source changes',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        username: 'avatar-source-change',
        password: 'test-password-1234',
        avatar_url: 'https://legacy.example.com/avatar-512.png',
        avatar_source: 'legacy-import',
        avatar_source_id: 'legacy-456',
        avatar_synced_at: '2026-06-24T00:00:00.000Z',
      });

      const updated = await service.patch(user.user_id as UserID, {
        avatar_url: 'https://local.example.com/avatar.png',
        avatar_source: 'manual',
      });

      expect(updated.avatar_url).toBe('https://local.example.com/avatar.png');
      expect(updated.avatar_source).toBe('manual');
      expect(updated.avatar_source_id).toBeUndefined();
      expect(updated.avatar_synced_at).toBeUndefined();
    }
  );
});

describe('UsersService — OpenCode defaults', () => {
  dbTest('rejects an incomplete inline default before persistence', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    await expect(
      service.patch(id, {
        default_agentic_config: {
          opencode: { modelConfig: { mode: 'exact', model: 'gpt-test' } },
        },
        default_agentic_selection: { opencode: { source: 'inline' } },
      })
    ).rejects.toThrow(/provider and model/i);

    expect((await service.get(id)).default_agentic_config?.opencode).toBeUndefined();
  });

  dbTest('rejects unresolved workspace and preset defaults', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    await expect(
      service.patch(id, {
        default_agentic_selection: { opencode: { source: 'workspace_default' } },
      })
    ).rejects.toThrow(/provider and model/i);

    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'opencode', name: 'Permissions only', configuration: { permissionMode: 'yolo' } },
      id
    );
    await expect(
      service.patch(id, {
        default_agentic_selection: {
          opencode: { source: 'preset', preset_id: preset.preset_id },
        },
      })
    ).rejects.toThrow(/provider and model/i);

    expect((await service.get(id)).default_agentic_selection?.opencode).toBeUndefined();
  });

  dbTest('persists a complete exact inline pair', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    const updated = await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    expect(updated.default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });

  dbTest('validates removals against the complete replacement state', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    await expect(service.patch(id, { default_agentic_config: {} })).rejects.toThrow(
      /provider and model/i
    );
    expect((await service.get(id)).default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });

  dbTest('normalizes a provider/model alias to an exact durable pair', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    const updated = await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'alias', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    expect(updated.default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });
});

describe('UsersService — Codex response mode defaults', () => {
  dbTest('persists Fast mode through normalization and reload', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    const updated = await service.patch(id, {
      default_agentic_config: {
        codex: {
          modelConfig: {
            mode: 'alias',
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
            serviceTier: 'fast',
          },
        },
      },
    });

    expect(updated.default_agentic_config?.codex?.modelConfig?.serviceTier).toBe('fast');
    expect((await service.get(id)).default_agentic_config?.codex?.modelConfig?.serviceTier).toBe(
      'fast'
    );
  });
});
