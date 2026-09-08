import type { Session } from '@disco/core/types';

export function buildSessionCreatedAnalyticsProperties(session: Session): Record<string, unknown> {
  return {
    session_id: session.session_id,
    agent_id: session.agent_id ?? null,
    agentic_tool: session.agentic_tool,
    agentic_tool_version: session.agentic_tool_version ?? null,
    model: session.model_config?.model ?? null,
    model_mode: session.model_config?.mode ?? null,
    provider: session.model_config?.provider ?? null,
    permission_mode: session.permission_config?.mode ?? null,
    has_parent_session: Boolean(session.genealogy?.parent_session_id),
    has_fork_source: Boolean(session.genealogy?.forked_from_session_id),
    fork_origin: session.fork_origin ?? null,
  };
}
