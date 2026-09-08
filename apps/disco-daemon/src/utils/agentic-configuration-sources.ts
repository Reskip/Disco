import type { MaterializedAgenticToolConfiguration } from '@disco/core/config';
import type {
  AgenticToolConfigurationSource,
  PersistedScheduleAgenticToolConfig,
  ScheduleAgenticToolConfig,
} from '@disco/core/types';

export function scheduleAgenticToolConfigToSource(
  config: ScheduleAgenticToolConfig | PersistedScheduleAgenticToolConfig
): AgenticToolConfigurationSource {
  if (config.configuration_reference !== undefined) {
    return { reference: config.configuration_reference };
  }
  if (config.preset_id !== undefined) return { reference: config.preset_id };
  return {
    configuration: {
      modelConfig: config.model_config,
      permissionMode: config.permission_mode,
      codexSandboxMode: config.codex_sandbox_mode,
      codexApprovalPolicy: config.codex_approval_policy,
      codexNetworkAccess: config.codex_network_access,
    },
  };
}

export function materializedAgenticToolConfigurationToScheduleConfig(
  config: ScheduleAgenticToolConfig | PersistedScheduleAgenticToolConfig,
  materialized: MaterializedAgenticToolConfiguration
): PersistedScheduleAgenticToolConfig {
  return {
    agentic_tool: config.agentic_tool,
    ...(config.configuration_reference !== undefined
      ? { configuration_reference: config.configuration_reference }
      : config.preset_id !== undefined
        ? { preset_id: materialized.agentic_tool_preset_id ?? config.preset_id }
        : {}),
    ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
    permission_mode: materialized.permission_config.mode,
    ...(materialized.model_config ? { model_config: materialized.model_config } : {}),
    ...(materialized.permission_config.codex?.sandboxMode !== undefined
      ? { codex_sandbox_mode: materialized.permission_config.codex.sandboxMode }
      : {}),
    ...(materialized.permission_config.codex?.approvalPolicy !== undefined
      ? { codex_approval_policy: materialized.permission_config.codex.approvalPolicy }
      : {}),
    ...(materialized.permission_config.codex?.networkAccess !== undefined
      ? { codex_network_access: materialized.permission_config.codex.networkAccess }
      : {}),
  };
}

