import type {
  AgenticToolName,
  PermissionMode,
  PermissionScope,
  Session,
  SessionPromptResult,
  SpawnConfig,
} from '@disco-live/client';
import type React from 'react';
import { createContext, useContext } from 'react';

/**
 * AppActionsContext - Provides action callbacks for domain operations
 *
 * This context eliminates prop drilling for callbacks across the component tree.
 * All callbacks should be memoized with useCallback in the provider.
 */
export interface AppActionsContextValue {
  // Session actions
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode,
    options?: { steer?: boolean }
  ) =>
    | boolean
    | SessionPromptResult
    | undefined
    | Promise<boolean | SessionPromptResult | undefined>;
  onFork?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwFork?: (sessionId: string, prompt: string) => Promise<void>;
  onSubsession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;

  // Navigation/UI actions
  onOpenSettings?: (sessionId: string) => void;
  /** Open or select a Session by id. */
  onSessionClick?: (sessionId: string) => void;
  /** Open Settings deep-linked to a specific Agentic Tools provider tab. */
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
}

const AppActionsContext = createContext<AppActionsContextValue | undefined>(undefined);

interface AppActionsProviderProps {
  children: React.ReactNode;
  value: AppActionsContextValue;
}

export const AppActionsProvider: React.FC<AppActionsProviderProps> = ({ children, value }) => {
  return <AppActionsContext.Provider value={value}>{children}</AppActionsContext.Provider>;
};

/**
 * Hook to access application action callbacks
 *
 * @throws Error if used outside of AppActionsProvider
 *
 * @example
 * const { onSendPrompt, onFork, onUpdateSession } = useAppActions();
 * onSendPrompt(sessionId, "Hello!", "auto");
 */
export const useAppActions = (): AppActionsContextValue => {
  const context = useContext(AppActionsContext);
  if (!context) {
    throw new Error('useAppActions must be used within an AppActionsProvider');
  }
  return context;
};
