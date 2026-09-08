import type { AgenticToolName } from '@disco/core/types';

export function deploymentAgenticToolUnavailableMessage(tool: AgenticToolName): string {
  return `${tool} is unavailable under this deployment's agentic-tool policy. A deployment operator must add it to agentic_tools.installed in config.yaml, run disco install --sync, and restart the daemon.`;
}
