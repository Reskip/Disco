import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('prompt and widget transaction scopes', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('uses the long-route identity scope and short Task repository units for prompt admission', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart - 100, promptEnd);

    expect(promptStart).toBeGreaterThan(0);
    expect(prompt).toContain('registerLongAuthenticatedRoute(');
    expect(prompt).toContain('bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db))');
    expect(prompt).toContain(
      'isAgenticToolEnabledForTenant(db, promptTenantId, activeAgenticTool)'
    );
    expect(prompt).not.toContain(
      "registerAuthenticatedRoute(\n    app,\n    '/sessions/:id/prompt'"
    );
  });

  it('enforces direct Session ownership before admitting a Task', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, promptEnd);

    // Repository admission bypasses the tasks.create hook, so ownership must
    // be checked before the durable Task row is created.
    const ownershipCheck = prompt.indexOf('assertSessionOwnedByActor(params.user, session)');
    const taskAdmission = prompt.indexOf('taskRepo.createPending(');
    expect(ownershipCheck).toBeGreaterThan(0);
    expect(taskAdmission).toBeGreaterThan(0);
    expect(ownershipCheck).toBeLessThan(taskAdmission);

    // Internal daemon calls and the scoped executor service account retain
    // their narrow bypass; ordinary users never inherit repository access.
    expect(prompt).toContain('const isInternalPrompt = !params.provider;');
    expect(prompt).toContain('_isServiceAccount');
    expect(prompt).toContain('if (!isInternalPrompt && !isPromptServiceAccount)');
    expect(prompt).not.toContain('resolveSessionPromptAccess({');
  });

  it('does not keep a route-wide tenant transaction over widget external work', () => {
    for (const path of ["'/widgets/:id/submit'", "'/widgets/:id/dismiss'"]) {
      const start = source.indexOf(path);
      const route = source.slice(start - 100, start + 900);
      expect(start).toBeGreaterThan(0);
      expect(route).toContain('registerLongAuthenticatedRoute(');
    }
  });

  it('routes prompt admission and explicit Task runs through server-owned provenance', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const runStart = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, runStart);
    const run = source.slice(runStart, source.indexOf("'/sessions/:id/spawn-prompt'", runStart));

    expect(prompt).toContain('normalizeMessageSource(data.messageSource, params)');
    expect(prompt).toContain('buildPromptTaskMetadata(data.metadata, messageSource, createdBy');
    expect(run).toContain('messageSource: normalizeMessageSource(data.messageSource, params)');
  });

  it('falls back from a raced steering hint to ordinary prompt admission', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const runStart = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, runStart);

    const steeringBranch = prompt.indexOf('if (data.steer)');
    const ordinaryAdmission = prompt.indexOf('taskRepo.createPending(', steeringBranch);
    expect(steeringBranch).toBeGreaterThan(0);
    expect(ordinaryAdmission).toBeGreaterThan(steeringBranch);
    expect(prompt).toContain('if (!activeTask)');
    expect(prompt).toContain('if (!isTaskExecuting(patched)');
    expect(prompt).toContain('if (!stillActive) return null;');
    expect(prompt).toContain('if (steeringResult) return steeringResult;');
  });

  it('atomically converts one durable queued prompt into steering without losing it on failure', () => {
    const start = source.indexOf("'/sessions/:id/tasks/queue-steer'");
    const end = source.indexOf('async function processNextQueuedTaskInternal(', start);
    const route = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    const removeQueued = route.indexOf('tasksService.remove(queuedTask.task_id, params)');
    const steerPrompt = route.indexOf('const result = await promptRoute.create(');
    expect(removeQueued).toBeGreaterThan(0);
    expect(steerPrompt).toBeGreaterThan(removeQueued);
    expect(route).toContain('steer: true');
    expect(route).toContain('restoreRepo.createPending({');
    expect(route).toContain('task_id: queuedTask.task_id');
    expect(route).toContain("event: 'queued'");
    expect(route).toContain('data: restored');
  });

  it('restores the queued user before hooked Session recovery under branch RBAC', () => {
    const start = source.indexOf('async function processNextQueuedTaskInternal(');
    const end = source.indexOf('// Inject queue processor into sessions service.', start);
    const drain = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    const userLookup = drain.indexOf('userRepo.findById(userId)');
    const sessionRead = drain.indexOf('sessionsService.get(sessionId, taskParams)');
    expect(userLookup).toBeGreaterThan(0);
    expect(sessionRead).toBeGreaterThan(userLookup);
    expect(drain).toContain(
      'reconcileSessionPromptStateIfStuck(queuedSession, taskRepo, taskParams)'
    );
    expect(drain).not.toContain('event=drain_started');
    expect(drain).toContain('event=dispatched');
  });
});
