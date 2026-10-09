import { join, resolve } from 'node:path';
import { resolveDiscoUserWorkspaceDirectory } from '@disco/core';
import { type DiscoConfig, getWorktreesRoot, resolveMultiTenancyConfig } from '@disco/core/config';
import {
  and,
  eq,
  inArray,
  runWithTenantDatabaseScope,
  select,
  sessions,
  sql,
  type TenantScopeAwareDatabase,
  tasks,
  users,
} from '@disco/core/db';
import {
  NONTERMINAL_TASK_STATUSES,
  resolveIntermediateRetentionDays,
  type UserID,
  type UserPreferences,
} from '@disco/core/types';
import { cleanupWorkspaceCaches } from '../host/local/workspace-cache-cleanup.js';

/** Local single-daemon maintenance; never starts a cross-tenant filesystem sweep. */
export class WorkspaceStorageMaintenance {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DiscoConfig
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(60_000);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .catch((error: unknown) =>
          console.warn('[storage] Temporary-file cleanup failed; will retry', error)
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(60 * 60 * 1000);
        });
    }, delay);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async runOnce(dryRun = false): Promise<void> {
    const tenancy = resolveMultiTenancyConfig(this.config);
    // Auth-resolved or remotely mounted execution requires host-owned scoped
    // maintenance. This worker only knows its standalone local account tree.
    if (tenancy.mode !== 'static' || this.config.execution?.executor_command_template) return;
    const tenantId = tenancy.static_tenant_id;
    const owners = (await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
      select(db, { id: users.user_id, data: users.data }).from(users).all()
    )) as Array<{ id: UserID; data: { preferences?: UserPreferences } }>;
    const worktreesRoot = resolve(getWorktreesRoot(tenantId));
    for (const owner of owners) {
      if (this.stopped && !dryRun) break;
      const retentionDays = resolveIntermediateRetentionDays(
        owner.data?.preferences as UserPreferences | undefined
      );
      if (retentionDays === 0) continue;
      const userRoot = resolveDiscoUserWorkspaceDirectory(worktreesRoot, owner.id);
      // Enforce exactly one known account below the configured storage root.
      if (resolve(join(userRoot, '..')) !== worktreesRoot) continue;
      const isIdle = async () => {
        if (this.stopped && !dryRun) return false;
        const active = (await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
          select(db, { id: tasks.task_id })
            .from(tasks)
            .where(
              and(
                inArray(tasks.status, [...NONTERMINAL_TASK_STATUSES]),
                sql`exists (select 1 from ${sessions} where ${sessions.session_id} = ${tasks.session_id} and ${eq(sessions.created_by, owner.id)})`
              )
            )
            .limit(1)
            .all()
        )) as Array<{ id: string }>;
        return active.length === 0;
      };
      if (!(await isIdle())) continue;
      const result = await cleanupWorkspaceCaches({ userRoot, retentionDays, isIdle, dryRun });
      if (result.eligible > 0 || result.truncated) {
        console.log('[storage] Temporary-file cleanup', { userId: owner.id, dryRun, ...result });
      }
    }
  }
}
