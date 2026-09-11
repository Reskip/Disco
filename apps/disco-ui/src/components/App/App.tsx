import { MenuOutlined } from '@ant-design/icons';
import type {
  Agent,
  AgenticToolName,
  CreateMCPServerInput,
  CreateUserInput,
  DiscoClient,
  PermissionMode,
  PermissionScope,
  Session,
  SessionPromptResult,
  SpawnConfig,
  UpdateUserInput,
  User,
} from '@disco-live/client';
import { isAgenticToolName, PermissionScope as Scope } from '@disco-live/client';
import { Button, Layout, Spin, theme, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { MOBILE_WORKSPACE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { discoStore, useDiscoStore } from '../../store/discoStore';
import { makeSessionMcpServerIdsSelector, selectUserById } from '../../store/selectors';
import type { AgenticToolOption } from '../../types';
import type { NewSessionConfig } from '../../types/sessionCreation';
import { applyStoredDisplayScale } from '../../utils/displayScale';
import { useThemedMessage } from '../../utils/message';
import { resolveQuickStartMcpServerIds } from '../../utils/resolveQuickStartMcpServerIds';
import { getUserDefaultConfigurationSource } from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { HomePage } from '../HomePage';
import { SessionPanel } from '../SessionPanel';
import {
  WorkspaceAgentEditModal,
  WorkspaceSessionSearchModal,
  WorkspaceSettingsModal,
  WorkspaceSidebar,
  type WorkspaceTeammateCreateInput,
} from '../WorkspaceShell';
import './WorkspaceApp.css';

export interface AppProps {
  client: DiscoClient | null;
  user?: User | null;
  connected?: boolean;
  connecting?: boolean;
  workspaceLoading?: boolean;
  availableAgents: AgenticToolOption[];
  initialBoardId?: string;
  openSettingsTab?: string | null;
  onSettingsClose?: () => void;
  openUserSettings?: boolean;
  initialUserSettingsTab?: string;
  onUserSettingsClose?: () => void;
  onRestartOnboarding?: () => void | Promise<void>;
  openNewBranchModal?: boolean;
  onNewBranchModalClose?: () => void;
  suppressLeftPanel?: boolean;
  topBanner?: React.ReactNode;
  onCreateSession?: (config: NewSessionConfig) => Promise<string | null>;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
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
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void | Promise<void>;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void | Promise<void>;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: CreateMCPServerInput) => void;
  onDeleteMCPServer?: (mcpServerId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onLogout?: () => void;
  onRetryConnection?: () => void;
  instanceLabel?: string;
  instanceDescription?: string;
  uploadPolicy?: import('@disco/core/types').UploadIngressPolicy;
}

const EMPTY_STRING_ARRAY: string[] = Object.freeze([] as string[]) as string[];
const MOBILE_HISTORY_STATE_KEY = '__discoMobileLayer';
type MobileLayer = 'sidebar' | 'settings' | 'agent';

function isMobileWorkspaceLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_WORKSPACE_QUERY).matches;
}

export const App: React.FC<AppProps> = ({
  client,
  user,
  connected = false,
  workspaceLoading = false,
  availableAgents,
  openSettingsTab,
  onSettingsClose,
  openUserSettings,
  initialUserSettingsTab,
  onUserSettingsClose,
  topBanner,
  onCreateSession,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onSendPrompt,
  onUpdateSession,
  onDeleteSession,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onLogout,
  uploadPolicy,
}) => {
  const { token } = theme.useToken();
  const { showError, showInfo, showSuccess } = useThemedMessage();
  const navigation = useAppNavigation();
  const location = useLocation();
  const mobileLayout = useMediaQuery(MOBILE_WORKSPACE_QUERY);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | null>(null);
  const [archivedPreviewSessionId, setArchivedPreviewSessionId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const userById = useDiscoStore(selectUserById);
  const sessionRouteFragment = useMemo(() => {
    const match = location.pathname.match(/^\/s\/([^/]+)\/?$/i);
    return match?.[1] ? match[1].replace(/-/g, '').toLowerCase() : null;
  }, [location.pathname]);
  const routedSession = useDiscoStore(
    useMemo(
      () => (state) => {
        if (!sessionRouteFragment) return null;
        return (
          Array.from(state.sessionById.values()).find((session) =>
            session.session_id.replace(/-/g, '').toLowerCase().startsWith(sessionRouteFragment)
          ) ?? null
        );
      },
      [sessionRouteFragment]
    )
  );
  const selectedSession = routedSession?.archived ? null : routedSession;
  const archivedRouteSession = routedSession?.archived ? routedSession : null;
  const effectiveSelectedSessionId = selectedSession?.session_id ?? null;
  const selectedAgent = selectedSession?.agent_id
    ? (agents.find((agent) => agent.agent_id === selectedSession.agent_id) ?? null)
    : null;
  const editingAgent = agents.find((agent) => agent.agent_id === editingAgentId) ?? null;
  const selectedSessionMcpServerIds =
    useDiscoStore(
      useMemo(
        () => makeSessionMcpServerIdsSelector(effectiveSelectedSessionId),
        [effectiveSelectedSessionId]
      )
    ) ?? EMPTY_STRING_ARRAY;
  const readPatchInFlightRef = useRef(new Set<string>());
  const mobileLayerRef = useRef({
    sidebar: mobileSidebarOpen,
    settings: settingsOpen,
    agent: Boolean(editingAgentId),
  });

  useEffect(() => {
    mobileLayerRef.current = {
      sidebar: mobileSidebarOpen,
      settings: settingsOpen,
      agent: Boolean(editingAgentId),
    };
  }, [editingAgentId, mobileSidebarOpen, settingsOpen]);

  const markMobileLayer = useCallback((layer: MobileLayer) => {
    if (!isMobileWorkspaceLayout()) return;
    const currentState = (window.history.state ?? {}) as Record<string, unknown>;
    const nextState = { ...currentState, [MOBILE_HISTORY_STATE_KEY]: layer };
    if (currentState[MOBILE_HISTORY_STATE_KEY]) {
      window.history.replaceState(nextState, '', window.location.href);
    } else {
      window.history.pushState(nextState, '', window.location.href);
    }
  }, []);

  const clearMobileLayerMarker = useCallback(() => {
    if (!isMobileWorkspaceLayout()) return;
    const currentState = (window.history.state ?? {}) as Record<string, unknown>;
    if (!currentState[MOBILE_HISTORY_STATE_KEY]) return;
    const nextState = { ...currentState };
    delete nextState[MOBILE_HISTORY_STATE_KEY];
    window.history.replaceState(nextState, '', window.location.href);
  }, []);

  const dismissMobileLayer = useCallback((layer: MobileLayer) => {
    if (!isMobileWorkspaceLayout()) return;
    const currentState = (window.history.state ?? {}) as Record<string, unknown>;
    if (currentState[MOBILE_HISTORY_STATE_KEY] === layer) {
      window.history.back();
    }
  }, []);

  useEffect(() => {
    applyStoredDisplayScale(user?.user_id ?? null);
  }, [user?.user_id]);

  useEffect(() => {
    if (!mobileLayout) return;
    setSearchOpen(false);
    setSettingsOpen(false);
    setEditingAgentId(null);
  }, [mobileLayout]);

  useEffect(() => {
    if (!archivedRouteSession) return;
    navigation.goHome();
    if (mobileLayout) {
      showInfo('请在桌面端管理已归档会话');
      return;
    }
    setArchivedPreviewSessionId(archivedRouteSession.session_id);
    setSettingsInitialTab('archives');
    setSettingsOpen(true);
  }, [archivedRouteSession, mobileLayout, navigation, showInfo]);

  useEffect(() => {
    if (!client || !user?.user_id) {
      setAgents([]);
      return;
    }
    let active = true;
    const service = client.service('agents');
    const replace = (next: Agent[]) => {
      if (active) setAgents(next.filter((agent) => !agent.archived));
    };
    const upsert = (agent: Agent) => {
      if (!active) return;
      setAgents((previous) => {
        const next = previous.filter((item) => item.agent_id !== agent.agent_id);
        if (!agent.archived) next.push(agent);
        return next;
      });
    };
    const remove = (agent: Agent) => {
      if (active)
        setAgents((previous) => previous.filter((item) => item.agent_id !== agent.agent_id));
    };
    void service
      .findAll()
      .then(replace)
      .catch((error) => {
        if (active)
          showError(`加载智能体失败：${error instanceof Error ? error.message : String(error)}`);
      });
    service.on('created', upsert);
    service.on('patched', upsert);
    service.on('removed', remove);
    return () => {
      active = false;
      service.removeListener('created', upsert);
      service.removeListener('patched', upsert);
      service.removeListener('removed', remove);
    };
  }, [client, showError, user?.user_id]);

  useEffect(() => {
    if (!client || !selectedSession) return;

    const markVisibleConversationRead = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;

      if (selectedSession.ready_for_prompt) {
        const key = `session:${selectedSession.session_id}`;
        if (!readPatchInFlightRef.current.has(key)) {
          readPatchInFlightRef.current.add(key);
          void client
            .service('sessions')
            .patch(selectedSession.session_id, { ready_for_prompt: false })
            .catch(() => {
              readPatchInFlightRef.current.delete(key);
            });
        }
      } else {
        readPatchInFlightRef.current.delete(`session:${selectedSession.session_id}`);
      }
    };

    markVisibleConversationRead();
    window.addEventListener('focus', markVisibleConversationRead);
    document.addEventListener('visibilitychange', markVisibleConversationRead);
    return () => {
      window.removeEventListener('focus', markVisibleConversationRead);
      document.removeEventListener('visibilitychange', markVisibleConversationRead);
    };
  }, [client, selectedSession]);

  useEffect(() => {
    if (mobileLayout) return;
    if (openSettingsTab || openUserSettings) {
      mobileLayerRef.current = { sidebar: false, settings: true, agent: false };
      setMobileSidebarOpen(false);
      setSettingsInitialTab(openSettingsTab || initialUserSettingsTab || 'profile');
      setSettingsOpen(true);
      markMobileLayer('settings');
    }
  }, [initialUserSettingsTab, markMobileLayer, mobileLayout, openSettingsTab, openUserSettings]);

  const closeSettings = useCallback(() => {
    mobileLayerRef.current.settings = false;
    setSettingsOpen(false);
    onSettingsClose?.();
    onUserSettingsClose?.();
    dismissMobileLayer('settings');
  }, [dismissMobileLayer, onSettingsClose, onUserSettingsClose]);

  const openSettings = useCallback(() => {
    if (mobileLayout) return;
    mobileLayerRef.current = { sidebar: false, settings: true, agent: false };
    setMobileSidebarOpen(false);
    setSettingsInitialTab('profile');
    setArchivedPreviewSessionId(null);
    setSettingsOpen(true);
    markMobileLayer('settings');
  }, [markMobileLayer, mobileLayout]);

  const openAgentEditor = useCallback(
    (agentId: string) => {
      if (mobileLayout) return;
      mobileLayerRef.current = { sidebar: false, settings: false, agent: true };
      setMobileSidebarOpen(false);
      setEditingAgentId(agentId);
      markMobileLayer('agent');
    },
    [markMobileLayer, mobileLayout]
  );

  const openArchivedSessionManager = useCallback((sessionId: string) => {
    setSearchOpen(false);
    setArchivedPreviewSessionId(sessionId);
    setSettingsInitialTab('archives');
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (mobileLayout) return;
    const openSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', openSearchShortcut);
    return () => window.removeEventListener('keydown', openSearchShortcut);
  }, [mobileLayout]);

  const closeAgentEditor = useCallback(() => {
    mobileLayerRef.current.agent = false;
    setEditingAgentId(null);
    dismissMobileLayer('agent');
  }, [dismissMobileLayer]);

  const closeMobileSidebar = useCallback(() => {
    mobileLayerRef.current.sidebar = false;
    setMobileSidebarOpen(false);
    dismissMobileLayer('sidebar');
  }, [dismissMobileLayer]);

  useEffect(() => {
    const handleMobileBack = () => {
      if (!isMobileWorkspaceLayout()) return;
      const current = mobileLayerRef.current;
      if (current.agent) {
        setEditingAgentId(null);
        return;
      }
      if (current.settings) {
        setSettingsOpen(false);
        onSettingsClose?.();
        onUserSettingsClose?.();
        return;
      }
      if (current.sidebar) setMobileSidebarOpen(false);
    };
    window.addEventListener('popstate', handleMobileBack);
    return () => window.removeEventListener('popstate', handleMobileBack);
  }, [onSettingsClose, onUserSettingsClose]);

  const chooseDefaultTool = useCallback(
    (preferred?: string): AgenticToolName | null => {
      const enabled = new Set(availableAgents.map((agent) => agent.id));
      for (const candidate of [preferred, 'codex', availableAgents[0]?.id]) {
        if (candidate && enabled.has(candidate) && isAgenticToolName(candidate)) return candidate;
      }
      return null;
    },
    [availableAgents]
  );

  const selectAndNavigate = useCallback(
    (sessionId: string) => {
      navigation.goToSession(sessionId);
    },
    [navigation]
  );

  const createConversation = useCallback(
    async (
      agentId: string | null,
      tool: AgenticToolName,
      options?: {
        title?: string;
        replacingSessionId?: string;
      }
    ): Promise<string | null> => {
      const sessionId = await onCreateSession?.({
        agent_id: agentId,
        agent: tool,
        title: options?.title,
        agenticToolPresetId: getUserDefaultConfigurationSource(user, tool),
        mcpServerIds: resolveQuickStartMcpServerIds(user),
      });
      if (!sessionId) return null;

      selectAndNavigate(sessionId);
      if (options?.replacingSessionId && client) {
        try {
          await client
            .service('sessions')
            .remove(options.replacingSessionId, { query: { _swapReplace: true } });
        } catch (error) {
          console.error('Failed to remove replaced session:', error);
        }
      }
      return sessionId;
    },
    [client, onCreateSession, selectAndNavigate, user]
  );

  const startStandaloneConversation = useCallback(async () => {
    if (creatingConversation) return;
    setCreatingConversation(true);
    try {
      const tool = chooseDefaultTool();
      if (!tool) throw new Error('没有可用的 AI 执行工具');
      const sessionId = await createConversation(null, tool);
      if (!sessionId) throw new Error('无法创建对话');
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingConversation(false);
    }
  }, [chooseDefaultTool, createConversation, creatingConversation, showError]);

  const talkToAgent = useCallback(
    async (agentId: string) => {
      if (creatingConversation) return;
      setCreatingConversation(true);
      try {
        const { sessionById } = discoStore.getState();
        const agent = agents.find((item) => item.agent_id === agentId);
        if (!agent) throw new Error('找不到这个智能体');
        const lastSession = Array.from(sessionById.values())
          .filter((session) => session.agent_id === agentId && session.created_by === user?.user_id)
          .sort(
            (a, b) =>
              new Date(b.last_updated || b.created_at).getTime() -
              new Date(a.last_updated || a.created_at).getTime()
          )[0];
        const tool = chooseDefaultTool(lastSession?.agentic_tool);
        if (!tool) throw new Error('没有可用的 AI 执行工具');
        const sessionId = await createConversation(agent.agent_id, tool);
        if (!sessionId) throw new Error('无法创建对话');
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingConversation(false);
      }
    },
    [chooseDefaultTool, createConversation, creatingConversation, agents, showError, user?.user_id]
  );

  const createTeammate = useCallback(
    async (input: WorkspaceTeammateCreateInput) => {
      if (!client) throw new Error('本地服务尚未连接');
      const created = (await client.service('agents').create({
        display_name: input.displayName,
        description: input.description,
        emoji: input.emoji,
        avatar_url: input.avatarUrl,
      })) as Agent;
      const sessionId = await createConversation(created.agent_id, 'codex');
      if (!sessionId) throw new Error('智能体已创建，但对话启动失败');
    },
    [client, createConversation]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      const { sessionById } = discoStore.getState();
      const session = sessionById.get(sessionId);
      if (client && session?.ready_for_prompt) {
        client
          .service('sessions')
          .patch(sessionId, { ready_for_prompt: false })
          .catch(() => {});
      }
      selectAndNavigate(sessionId);
    },
    [client, selectAndNavigate]
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await onUpdateSession?.(sessionId, { title });
    },
    [onUpdateSession]
  );

  const deleteSessionFromSidebar = useCallback(
    async (sessionId: string) => {
      await onDeleteSession?.(sessionId);
      if (effectiveSelectedSessionId === sessionId) {
        navigation.goHome();
      }
    },
    [effectiveSelectedSessionId, navigation, onDeleteSession]
  );

  const archiveSessionFromSidebar = useCallback(
    async (sessionId: string) => {
      if (!client) throw new Error('本地服务尚未连接');
      try {
        await client.service(`sessions/${sessionId}/archive`).create({ includeChildren: false });
        if (effectiveSelectedSessionId === sessionId) navigation.goHome();
        showSuccess('对话已归档');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showError(`归档失败：${message}`);
        throw error;
      }
    },
    [client, effectiveSelectedSessionId, navigation, showError, showSuccess]
  );

  const deleteAgentFromSidebar = useCallback(
    async (agentId: string, confirmation: string) => {
      if (!client) throw new Error('本地服务尚未连接');
      const selectedBelongsToAgent = selectedSession?.agent_id === agentId;
      await client.service('agents').remove(agentId, { query: { confirmation } });
      if (selectedBelongsToAgent) navigation.goHome();
    },
    [client, navigation, selectedSession?.agent_id]
  );

  const handlePermissionDecision = useCallback(
    async (
      sessionId: string,
      requestId: string,
      taskId: string,
      allow: boolean,
      scope: PermissionScope
    ) => {
      if (!client) return;
      try {
        await client.service(`sessions/${sessionId}/permission-decision`).create({
          requestId,
          taskId,
          allow,
          reason: allow ? 'Approved by user' : 'Denied by user',
          remember: scope !== Scope.ONCE,
          scope,
        });
      } catch (error) {
        console.error('Failed to send permission decision:', error);
      }
    },
    [client]
  );

  const appActions = useMemo(
    () => ({
      onSendPrompt,
      onFork: onForkSession,
      onBtwFork: onBtwForkSession,
      onSubsession: onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      onPermissionDecision: handlePermissionDecision,
      onOpenSettings: openSettings,
      onSessionClick: handleSessionClick,
    }),
    [
      handlePermissionDecision,
      handleSessionClick,
      onBtwForkSession,
      onDeleteSession,
      onForkSession,
      onSendPrompt,
      onSpawnSession,
      onUpdateSession,
      openSettings,
    ]
  );

  return (
    <AppActionsProvider value={appActions}>
      <Layout
        className="disco-workspace-app"
        style={{ width: '100%', height: '100%', background: token.colorBgBase }}
      >
        <WorkspaceSidebar
          mobileOpen={mobileSidebarOpen}
          mobile={mobileLayout}
          currentUser={user}
          agents={agents}
          selectedSessionId={effectiveSelectedSessionId}
          loading={workspaceLoading}
          creating={creatingConversation}
          connected={connected}
          onGoHome={() => {
            setMobileSidebarOpen(false);
            clearMobileLayerMarker();
            navigation.goHome();
          }}
          onSelectSession={(sessionId) => {
            setMobileSidebarOpen(false);
            clearMobileLayerMarker();
            handleSessionClick(sessionId);
          }}
          onNewStandalone={() => {
            setMobileSidebarOpen(false);
            clearMobileLayerMarker();
            return startStandaloneConversation();
          }}
          onTalkToAgent={(agentId) => {
            setMobileSidebarOpen(false);
            clearMobileLayerMarker();
            return talkToAgent(agentId);
          }}
          onRenameSession={renameSession}
          onDeleteSession={deleteSessionFromSidebar}
          onArchiveSession={archiveSessionFromSidebar}
          onEditAgent={openAgentEditor}
          onOpenSettings={openSettings}
          onOpenSearch={() => setSearchOpen(true)}
          onLogout={onLogout}
        />
        {mobileSidebarOpen && (
          <button
            type="button"
            className="disco-workspace-sidebar-backdrop"
            aria-label="关闭导航栏"
            onClick={closeMobileSidebar}
          />
        )}
        <main className="disco-workspace-main" style={{ background: token.colorBgContainer }}>
          <Button
            className="disco-workspace-mobile-menu"
            type="text"
            shape="circle"
            size="large"
            aria-label="打开导航栏"
            icon={<MenuOutlined />}
            onClick={() => {
              mobileLayerRef.current = { sidebar: true, settings: false, agent: false };
              setMobileSidebarOpen(true);
              markMobileLayer('sidebar');
            }}
          />
          {topBanner}
          {selectedSession && (
            <SessionPanel
              client={client}
              session={selectedSession}
              agentEmoji={selectedAgent?.emoji}
              currentUserId={user?.user_id}
              sessionMcpServerIds={selectedSessionMcpServerIds}
              open
              onClose={() => navigation.goHome()}
              uploadPolicy={uploadPolicy}
            />
          )}
          {sessionRouteFragment && !routedSession && (
            <div className="disco-workspace-session-route-shell">
              <div className="disco-workspace-session-route-header" aria-hidden="true">
                <span />
              </div>
              <div className="disco-workspace-session-route-state" role="status" aria-live="polite">
                {workspaceLoading ? (
                  <>
                    <Spin size="large" />
                    <span>正在加载对话…</span>
                  </>
                ) : (
                  <>
                    <span>没有找到这段对话，可能已被删除。</span>
                    <Button type="text" onClick={() => navigation.goHome()}>
                      返回主页
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
          <div
            hidden={Boolean(sessionRouteFragment)}
            aria-hidden={Boolean(sessionRouteFragment)}
            style={{ minWidth: 0, height: '100%' }}
          >
            <HomePage
              client={client}
              connected={connected}
              currentUser={user}
              availableAgents={availableAgents}
              creating={creatingConversation}
              onSessionClick={handleSessionClick}
              onNewSession={startStandaloneConversation}
              onCreateTeammate={mobileLayout ? undefined : createTeammate}
              mobileMinimal={mobileLayout}
            />
          </div>
        </main>
        <Upload style={{ display: 'none' }} openFileDialogOnClick={false} showUploadList={false} />
        {!mobileLayout && (
          <>
            <WorkspaceSessionSearchModal
              open={searchOpen}
              client={client}
              onClose={() => setSearchOpen(false)}
              onOpenSession={(sessionId) => {
                setSearchOpen(false);
                handleSessionClick(sessionId);
              }}
              onOpenArchivedSession={openArchivedSessionManager}
            />
            <WorkspaceSettingsModal
              open={settingsOpen}
              currentUser={user}
              users={Array.from(userById.values())}
              client={client}
              initialTab={settingsInitialTab}
              initialArchivedSessionId={archivedPreviewSessionId}
              onClose={closeSettings}
              onCreateUser={onCreateUser}
              onUpdateUser={onUpdateUser}
              onDeleteUser={onDeleteUser}
              onLogout={onLogout}
            />
            <WorkspaceAgentEditModal
              open={Boolean(editingAgentId)}
              client={client}
              agent={editingAgent}
              onDeleteAgent={deleteAgentFromSidebar}
              onClose={closeAgentEditor}
            />
          </>
        )}
      </Layout>
    </AppActionsProvider>
  );
};
