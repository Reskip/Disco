import {
  type DeploymentAgenticToolPolicy,
  isDeploymentAgenticToolAvailable,
  isTenantAgenticToolEnabled,
} from '@disco/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import type { AgenticToolName, AuthenticatedParams, Session } from '@disco/core/types';
import type { SessionsServiceImpl } from '../declarations.js';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';

type ExecutorStartupSessionsService = Pick<
  SessionsServiceImpl,
  'get' | 'materializeAgenticToolPreset'
>;

export type ActiveExecutorSession = Session & { agentic_tool: AgenticToolName };

/**
 * Load and validate the session state needed before any executor/process work begins.
 *
 * This is the funnel every executor launch passes through: `/sessions/:id/prompt`,
 * the queue drainer, `/tasks/:id/run`, gateway and scheduled prompts all arrive
 * here via `SessionsService.executeTask`. The Session row directly carries its
 * user, optional Agent, and working directory; no indirect workspace identity
 * carrier participates in startup.
 */
export async function prepareSessionForExecutorStart(
  db: TenantScopeAwareDatabase,
  sessionsService: ExecutorStartupSessionsService,
  sessionId: string,
  params: AuthenticatedParams,
  deploymentPolicy: DeploymentAgenticToolPolicy = { managed: false, installed: new Set() }
): Promise<ActiveExecutorSession> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Missing active tenant context for executor startup');

  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const session = await sessionsService.get(sessionId, params);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const agenticTool = requireActiveAgenticTool(session.agentic_tool);
    if (!isDeploymentAgenticToolAvailable(agenticTool, deploymentPolicy)) {
      throw new Error(`${agenticTool} is not installed for this deployment`);
    }
    if (!(await isTenantAgenticToolEnabled(agenticTool, tenantDb))) {
      throw new Error(`${agenticTool} is disabled for this workspace`);
    }
    const materializedSession = await sessionsService.materializeAgenticToolPreset(session, params);
    requireActiveAgenticTool(materializedSession.agentic_tool);
    return materializedSession as ActiveExecutorSession;
  });
}
