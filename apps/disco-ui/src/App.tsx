import type {
  CreateUserInput,
  PermissionMode,
  Session,
  SessionID,
  SessionPromptResult,
  SpawnConfig,
  UpdateUserInput,
  User,
} from '@disco-live/client';
import { Alert, ConfigProvider } from 'antd';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AVAILABLE_AGENTS } from './components/AgentSelectionGrid';
import { ErrorBoundary, setCrashContext } from './components/ErrorBoundary';
import { uploadFilesToSession } from './components/FileUpload/upload';
import { ForcePasswordChangeModal } from './components/ForcePasswordChangeModal';
import { InitialLoadingScreen } from './components/InitialLoadingScreen';
import { LoginPage } from './components/LoginPage';
import type { NewSessionConfig } from './types/sessionCreation';
import { buildPromptWithAttachments } from './components/SessionPanel/composerAttachments';
import { StreamdownPortalApp } from './components/StreamdownPortalApp';
import { getDaemonUrl } from './config/daemon';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { LocaleProvider, useLocale } from './contexts/LocaleContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import {
  useAuth,
  useAuthConfig,
  useDiscoClient,
  useServerVersion,
  useSessionActions,
} from './hooks';
import { useConversationData } from './hooks/useConversationData';
import { sessionCreated } from './store/discoRealtimeActions';
import { useDiscoStore } from './store/discoStore';
import { SharedUserSettingsModal } from './surfaces/SharedUserSettingsModal';
import { getRouteSurface } from './surfaces/surfaceRegistry';
import { useSurfaceBranding } from './hooks/useSurfaceBranding';
import { completeForcedPasswordChange } from './utils/forcePasswordChange';
import { useThemedMessage } from './utils/message';
import { getDiscoPortalContainer } from './utils/portalContainer';
import { getRouterBasename } from './utils/uiRoutes';

// Start downloading the main workspace bundle immediately instead of waiting
// for authentication to finish and creating another public-network waterfall.
const discoAppModule = import('./components/App');
const DiscoApp = lazy(() => discoAppModule.then((module) => ({ default: module.App })));
const MarketplacePage = lazy(() =>
  import('./pages/MarketplacePage').then((module) => ({ default: module.MarketplacePage }))
);
function isWorkspacePath(pathname: string): boolean {
  return !pathname.startsWith('/marketplace');
}

function AppContent() {
  const { showError, showSuccess } = useThemedMessage();
  const location = useLocation();
  const currentSurface = useMemo(() => getRouteSurface(location.pathname), [location.pathname]);
  useSurfaceBranding(currentSurface);
  const workspaceShouldRun = isWorkspacePath(location.pathname);
  const marketplaceOpen = location.pathname.startsWith('/marketplace');
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);

  const {
    config: authConfig,
    featuresConfig,
    error: authConfigError,
  } = useAuthConfig();
  const {
    user,
    authenticated,
    loading: authLoading,
    error: authError,
    accessToken,
    login,
    logout,
    reAuthenticate,
  } = useAuth();
  const { client, connected, connecting, error: connectionError } = useDiscoClient({
    accessToken: authenticated ? accessToken : null,
  });
  const { capturedSha, currentSha, outOfSync } = useServerVersion(client);
  const connectionContextValue = useMemo(
    () => ({ connected, connecting, outOfSync, capturedSha, currentSha }),
    [capturedSha, connected, connecting, currentSha, outOfSync]
  );

  const directSessionIdFromPath = location.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1] ?? null;
  const { initialSyncComplete, error: dataError } = useConversationData(client, {
    enabled: workspaceShouldRun && authenticated && !user?.must_change_password,
    directSessionId: directSessionIdFromPath,
  });
  const { createSession, forkSession, btwForkSession, spawnSession, updateSession, deleteSession } =
    useSessionActions(client);

  const storedCurrentUser = useDiscoStore((state) =>
    user ? (state.userById.get(user.user_id) ?? null) : null
  );
  const currentUser = user ? storedCurrentUser || user : null;

  useEffect(() => {
    setCrashContext({
      buildSha: capturedSha,
      username: currentUser?.username ?? null,
    });
  }, [capturedSha, currentUser?.username]);

  const handleSendPrompt = useCallback(
    async (
      sessionId: string,
      prompt: string,
      permissionMode?: PermissionMode,
      options?: { steer?: boolean }
    ): Promise<SessionPromptResult | false> => {
      if (!client) return false;
      try {
        return await client.sessions.prompt(sessionId, prompt, {
          permissionMode,
          ...(options?.steer ? { steer: true } : {}),
        });
      } catch (error) {
        showError(`发送消息失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    [client, showError]
  );

  const handleUpdateSessionEnvSelections = useCallback(
    async (sessionId: string, envVarNames: string[]) => {
      if (!client || envVarNames.length === 0) return;
      await client.service(`sessions/${sessionId}/env-selections`).patch(null, { envVarNames });
    },
    [client]
  );

  const handleCreateSession = useCallback(
    async (config: NewSessionConfig): Promise<string | null> => {
      try {
        const { attachmentFiles, ...sessionConfig } = config;
        const session = await createSession(sessionConfig);
        sessionCreated(session);

        for (const mcpServerId of config.mcpServerIds ?? []) {
          await client?.service(`sessions/${session.session_id}/mcp-servers`).create({ mcpServerId });
        }
        await handleUpdateSessionEnvSelections(session.session_id, config.envVarNames ?? []);

        const initialPrompt = config.initialPrompt ?? '';
        if (attachmentFiles?.length) {
          try {
            const uploaded = await uploadFilesToSession({
              sessionId: session.session_id,
              daemonUrl: getDaemonUrl(),
              files: attachmentFiles,
              notifyAgent: false,
            });
            const promptWithAttachments = buildPromptWithAttachments(initialPrompt, uploaded.files);
            if (promptWithAttachments.trim()) {
              await handleSendPrompt(
                session.session_id,
                promptWithAttachments,
                config.permissionMode
              );
            }
          } catch (error) {
            showError(`附件上传失败：${error instanceof Error ? error.message : String(error)}`);
            if (initialPrompt.trim()) {
              await handleSendPrompt(session.session_id, initialPrompt, config.permissionMode);
            }
          }
        } else if (initialPrompt.trim()) {
          await handleSendPrompt(session.session_id, initialPrompt, config.permissionMode);
        }

        return session.session_id;
      } catch (error) {
        showError(`创建对话失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    [client, createSession, handleSendPrompt, handleUpdateSessionEnvSelections, showError]
  );

  const handleForkSession = useCallback(
    async (sessionId: string, prompt: string) => {
      try {
        await forkSession(sessionId as SessionID, prompt);
        showSuccess('已创建分支对话');
      } catch (error) {
        showError(`创建分支对话失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    [forkSession, showError, showSuccess]
  );

  const handleBtwForkSession = useCallback(
    async (sessionId: string, prompt: string) => {
      try {
        await btwForkSession(sessionId as SessionID, prompt);
        showSuccess('已发送旁路问题');
      } catch (error) {
        showError(`发送旁路问题失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    [btwForkSession, showError, showSuccess]
  );

  const handleSpawnSession = useCallback(
    async (sessionId: string, config: string | Partial<SpawnConfig>) => {
      const spawnConfig = typeof config === 'string' ? { prompt: config } : config;
      try {
        await spawnSession(sessionId as SessionID, spawnConfig);
        showSuccess('已创建子任务');
      } catch (error) {
        showError(`创建子任务失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    [showError, showSuccess, spawnSession]
  );

  const handleUpdateSession = useCallback(
    async (sessionId: string, updates: Partial<Session>) => {
      const updated = await updateSession(sessionId as SessionID, updates);
      if (!updated) throw new Error('会话配置更新失败');
    },
    [updateSession]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const removed = await deleteSession(sessionId as SessionID);
      if (!removed) throw new Error('删除对话失败');
    },
    [deleteSession]
  );

  const handleCreateUser = useCallback(
    async (data: CreateUserInput) => {
      if (!client) return;
      try {
        await client.service('users').create(data);
        showSuccess('账号已创建');
      } catch (error) {
        showError(`账号创建失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [client, showError, showSuccess]
  );

  const handleUpdateUser = useCallback(
    async (userId: string, updates: UpdateUserInput) => {
      if (!client) return;
      try {
        await client.service('users').patch(userId, updates as Partial<User>);
        showSuccess('设置已保存');
      } catch (error) {
        showError(`设置保存失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    [client, showError, showSuccess]
  );

  const handleDeleteUser = useCallback(
    async (userId: string) => {
      if (!client) return;
      try {
        await client.service('users').remove(userId);
        showSuccess('账号已删除');
      } catch (error) {
        showError(`账号删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [client, showError, showSuccess]
  );

  const handleForcePasswordChange = useCallback(
    async (userId: string, newPassword: string) => {
      if (!client || !currentUser?.username) throw new Error('当前账号不可用');
      const signedIn = await completeForcedPasswordChange({
        client,
        userId,
        username: currentUser.username,
        newPassword,
        login,
        logout,
      });
      showSuccess(signedIn ? '密码已修改' : '密码已修改，请重新登录');
    },
    [client, currentUser?.username, login, logout, showSuccess]
  );

  if (authConfigError && !authConfig) {
    return (
      <div className="disco-centered-status">
        <Alert
          type="warning"
          title="无法读取 Disco 服务配置"
          description={authConfigError.message}
          showIcon
        />
      </div>
    );
  }

  if (authLoading) return <InitialLoadingScreen message="正在验证账号…" />;
  if (!authenticated) return <LoginPage onLogin={login} error={authError} />;
  if (connectionError) {
    return (
      <div className="disco-centered-status">
        <Alert type="error" title="无法连接 Disco 服务" description={connectionError} showIcon />
      </div>
    );
  }
  if (
    workspaceShouldRun &&
    connected &&
    !initialSyncComplete &&
    dataError &&
    !user?.must_change_password
  ) {
    return (
      <div className="disco-centered-status">
        <Alert type="error" title="加载会话失败" description={dataError} showIcon />
      </div>
    );
  }

  const workspaceElement = (
    <DiscoApp
      client={client}
      user={currentUser}
      connected={connected}
      workspaceLoading={!initialSyncComplete || connecting}
      availableAgents={AVAILABLE_AGENTS}
      onCreateSession={handleCreateSession}
      onForkSession={handleForkSession}
      onBtwForkSession={handleBtwForkSession}
      onSpawnSession={handleSpawnSession}
      onSendPrompt={handleSendPrompt}
      onUpdateSession={handleUpdateSession}
      onDeleteSession={handleDeleteSession}
      onCreateUser={handleCreateUser}
      onUpdateUser={handleUpdateUser}
      onDeleteUser={handleDeleteUser}
      onLogout={logout}
      uploadPolicy={featuresConfig?.uploadPolicy}
    />
  );

  return (
    <ConnectionProvider value={connectionContextValue}>
      <ForcePasswordChangeModal
        open={Boolean(currentUser?.must_change_password)}
        user={currentUser}
        onChangePassword={handleForcePasswordChange}
        onLogout={logout}
      />
      {marketplaceOpen && (
        <SharedUserSettingsModal
          open={userSettingsOpen}
          onClose={() => setUserSettingsOpen(false)}
          user={currentUser}
          client={client}
          onUpdateUser={handleUpdateUser}
          onRefreshCurrentUser={reAuthenticate}
        />
      )}
      <Suspense fallback={<InitialLoadingScreen message="正在加载页面…" />}>
        <Routes>
          <Route
            path="/marketplace"
            element={
              <MarketplacePage
                client={client}
                connected={connected}
                currentUser={currentUser}
                onUserSettingsClick={() => setUserSettingsOpen(true)}
                onLogout={logout}
              />
            }
          />
          <Route path="/m/*" element={workspaceElement} />
          <Route path="/s/:sessionShortId/" element={workspaceElement} />
          <Route path="/*" element={workspaceElement} />
        </Routes>
      </Suspense>
    </ConnectionProvider>
  );
}

function AppWrapper() {
  const { getCurrentThemeConfig } = useTheme();
  const { antdLocale } = useLocale();

  return (
    <ConfigProvider
      theme={getCurrentThemeConfig()}
      locale={antdLocale}
      getPopupContainer={getDiscoPortalContainer}
    >
      <StreamdownPortalApp>
        <ErrorBoundary variant="global">
          <AppContent />
        </ErrorBoundary>
      </StreamdownPortalApp>
    </ConfigProvider>
  );
}

function App() {
  return (
    <BrowserRouter basename={getRouterBasename()}>
      <ThemeProvider>
        <LocaleProvider>
          <AppWrapper />
        </LocaleProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
