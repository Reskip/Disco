import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
} from '@disco-live/client';
import type { ModelConfig } from '../components/ModelSelector';

/** Input owned by the conversation product when creating a Disco Session. */
export interface NewSessionConfig {
  agent_id?: string | null;
  agent: string;
  agenticToolPresetId?: string;
  title?: string;
  initialPrompt?: string;
  modelConfig?: ModelConfig;
  effort?: EffortLevel;
  customContext?: Record<string, unknown>;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  envVarNames?: string[];
  /** Uploaded only after the Session exists; never part of the create payload. */
  attachmentFiles?: File[];
}
