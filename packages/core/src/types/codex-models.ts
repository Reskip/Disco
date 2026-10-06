import type { EffortLevel } from './session';

/** Metadata from the same Codex runtime that executes Disco conversations. */
export interface CodexModelOption {
  id: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: EffortLevel[];
  defaultReasoningEffort?: EffortLevel;
  upgrade?: string;
}

export interface CodexModelCatalog {
  models: CodexModelOption[];
  default: string;
  /** A fallback is never evidence that a previously saved model was removed. */
  source: 'dynamic' | 'cached' | 'static';
  fetchedAt?: string;
}
