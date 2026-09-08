import type {
  DiscoClient,
  MCPServer,
  Session,
  SessionMCPServer,
  TenantAgenticToolSettings,
  User,
} from '@disco-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildById, buildSessionMaps, buildSessionMcpMap } from '../store/discoMaps';
import * as realtime from '../store/discoRealtimeActions';
import { discoStore } from '../store/discoStore';
import { createInitialLoadDebugTimer, isInitialLoadDebugEnabled } from '../utils/initialLoadDebug';

export type LoadingStage = 'idle' | 'fetching' | 'indexing';

export interface LoadItem {
  key: 'sessions' | 'users';
  label: string;
  done: boolean;
  count: number;
}

const INITIAL_SESSION_LIMIT = 80;

async function findInitialSessions(client: DiscoClient): Promise<Session[]> {
  const result = await client.service('sessions').find({
    query: {
      $sort: { updated_at: -1 },
      $limit: INITIAL_SESSION_LIMIT,
    },
  });
  return Array.isArray(result) ? result : result.data;
}

interface ConversationDataResult {
  initialLoadItems: LoadItem[];
  initialLoadComplete: boolean;
  initialSyncComplete: boolean;
  restoredFromCache: false;
  loadingStage: LoadingStage;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function removeListener<T>(
  service: ReturnType<DiscoClient['service']>,
  event: 'created' | 'updated' | 'patched' | 'removed',
  handler: (data: T) => void
): void {
  service.removeListener(event, handler as (data: unknown) => void);
}

/**
 * Runtime data driver for the conversation product.
 *
 * The old canvas driver loaded unrelated collections before the chat shell
 * could render. This hook intentionally owns only the
 * entities used by current Session, settings and MCP surfaces.
 */
export function useConversationData(
  client: DiscoClient | null,
  options?: { enabled?: boolean; directSessionId?: string | null }
): ConversationDataResult {
  const enabled = options?.enabled !== false;
  const directSessionId = options?.directSessionId ?? null;
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [initialSyncComplete, setInitialSyncComplete] = useState(false);
  const [counts, setCounts] = useState({ sessions: 0, users: 0 });
  const refreshGeneration = useRef(0);
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    if (!client || !enabled) return;
    const generation = ++refreshGeneration.current;
    if (backgroundTimer.current) clearTimeout(backgroundTimer.current);
    setLoading(true);
    setLoadingStage('fetching');
    setError(null);
    const debugTimer = isInitialLoadDebugEnabled()
      ? createInitialLoadDebugTimer([
          { key: 'sessions', label: '首屏会话' },
          { key: 'users', label: '用户' },
        ])
      : null;
    debugTimer?.markStage('fetching');
    debugTimer?.startFetchPhase();
    try {
      const sessionPromise = findInitialSessions(client);
      const userPromise = client.service('users').findAll() as Promise<User[]>;
      const [sessions, users] = await Promise.all([
        debugTimer ? debugTimer.track('sessions', sessionPromise) : sessionPromise,
        debugTimer ? debugTimer.track('users', userPromise) : userPromise,
      ]);
      debugTimer?.endFetchPhase();
      if (generation !== refreshGeneration.current) return;

      if (
        directSessionId &&
        !sessions.some((session) =>
          session.session_id.replace(/-/g, '').startsWith(directSessionId.replace(/-/g, ''))
        )
      ) {
        try {
          sessions.push((await client.service('sessions').get(directSessionId)) as Session);
        } catch {
          // The normal route surface renders a not-found state after the live
          // snapshot; a missing deep link must not fail the entire workspace.
        }
      }

      setLoadingStage('indexing');
      debugTimer?.markStage('indexing');
      debugTimer?.startIndexing();
      discoStore.getState().applyMaps((previous) => ({
        ...previous,
        ...buildSessionMaps(sessions, previous),
        userById: buildById(users, 'user_id', previous.userById),
      }));
      setCounts({ sessions: sessions.length, users: users.length });
      setInitialSyncComplete(true);
      debugTimer?.endIndexing();
      debugTimer?.markStage('ready');
      debugTimer?.finish('success');

      // Yield one paint before hydrating collections that are not needed to
      // show Home, the sidebar, or the most recent conversations. This keeps
      // the first usable frame independent of a user's total session count.
      backgroundTimer.current = setTimeout(() => {
        backgroundTimer.current = null;
        void Promise.allSettled([
          client.service('sessions').findAll({
            query: { $sort: { updated_at: -1 } },
          }) as Promise<Session[]>,
          client.service('mcp-servers').findAll() as Promise<MCPServer[]>,
          client.service('session-mcp-servers').findAll() as Promise<SessionMCPServer[]>,
          client
            .service('agentic-tool-settings')
            .findAll() as Promise<TenantAgenticToolSettings[]>,
        ]).then(([allSessions, mcpServers, sessionMcpServers, toolSettings]) => {
          if (generation !== refreshGeneration.current) return;
          discoStore.getState().applyMaps((previous) => ({
            ...previous,
            ...(allSessions.status === 'fulfilled'
              ? buildSessionMaps(allSessions.value, previous)
              : {}),
            ...(mcpServers.status === 'fulfilled'
              ? {
                  mcpServerById: buildById(
                    mcpServers.value,
                    'mcp_server_id',
                    previous.mcpServerById
                  ),
                }
              : {}),
            ...(sessionMcpServers.status === 'fulfilled'
              ? { sessionMcpServerIds: buildSessionMcpMap(sessionMcpServers.value) }
              : {}),
          }));
          if (allSessions.status === 'fulfilled') {
            setCounts((previous) => ({ ...previous, sessions: allSessions.value.length }));
          }
          if (toolSettings.status === 'fulfilled') {
            discoStore.getState().setAgenticToolSettings(toolSettings.value);
          }
          if (mcpServers.status === 'fulfilled') {
            discoStore.getState().markHydrated('mcpServersHydrated');
          }
        });
      }, 0);
    } catch (reason) {
      debugTimer?.endFetchPhase();
      debugTimer?.finish('error', reason);
      if (generation !== refreshGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === refreshGeneration.current) {
        setLoading(false);
        setLoadingStage('idle');
      }
    }
  }, [client, directSessionId, enabled]);

  useEffect(() => {
    if (!client || !enabled) {
      refreshGeneration.current += 1;
      if (backgroundTimer.current) {
        clearTimeout(backgroundTimer.current);
        backgroundTimer.current = null;
      }
      setLoading(false);
      setInitialSyncComplete(false);
      return;
    }

    void refetch();
    const sessions = client.service('sessions');
    const users = client.service('users');
    const mcpServers = client.service('mcp-servers');
    const sessionMcpServers = client.service('session-mcp-servers');
    const toolSettings = client.service('agentic-tool-settings');

    sessions.on('created', realtime.sessionCreated);
    sessions.on('patched', realtime.sessionPatched);
    sessions.on('updated', realtime.sessionPatched);
    sessions.on('removed', realtime.sessionRemoved);
    users.on('created', realtime.userCreated);
    users.on('patched', realtime.userPatched);
    users.on('updated', realtime.userPatched);
    users.on('removed', realtime.userRemoved);
    mcpServers.on('created', realtime.mcpServerCreated);
    mcpServers.on('patched', realtime.mcpServerPatched);
    mcpServers.on('updated', realtime.mcpServerPatched);
    mcpServers.on('removed', realtime.mcpServerRemoved);
    sessionMcpServers.on('created', realtime.sessionMcpCreated);
    sessionMcpServers.on('removed', realtime.sessionMcpRemoved);
    const updateToolSetting = (setting: TenantAgenticToolSettings) =>
      discoStore.getState().upsertAgenticToolSetting(setting);
    toolSettings.on('created', updateToolSetting);
    toolSettings.on('patched', updateToolSetting);
    client.io?.on('connect', refetch);

    return () => {
      refreshGeneration.current += 1;
      if (backgroundTimer.current) {
        clearTimeout(backgroundTimer.current);
        backgroundTimer.current = null;
      }
      removeListener(sessions, 'created', realtime.sessionCreated);
      removeListener(sessions, 'patched', realtime.sessionPatched);
      removeListener(sessions, 'updated', realtime.sessionPatched);
      removeListener(sessions, 'removed', realtime.sessionRemoved);
      removeListener(users, 'created', realtime.userCreated);
      removeListener(users, 'patched', realtime.userPatched);
      removeListener(users, 'updated', realtime.userPatched);
      removeListener(users, 'removed', realtime.userRemoved);
      removeListener(mcpServers, 'created', realtime.mcpServerCreated);
      removeListener(mcpServers, 'patched', realtime.mcpServerPatched);
      removeListener(mcpServers, 'updated', realtime.mcpServerPatched);
      removeListener(mcpServers, 'removed', realtime.mcpServerRemoved);
      removeListener(sessionMcpServers, 'created', realtime.sessionMcpCreated);
      removeListener(sessionMcpServers, 'removed', realtime.sessionMcpRemoved);
      removeListener(toolSettings, 'created', updateToolSetting);
      removeListener(toolSettings, 'patched', updateToolSetting);
      client.io?.off('connect', refetch);
    };
  }, [client, enabled, refetch]);

  const initialLoadItems = useMemo<LoadItem[]>(
    () => [
      { key: 'sessions', label: '会话', done: initialSyncComplete, count: counts.sessions },
      { key: 'users', label: '用户', done: initialSyncComplete, count: counts.users },
    ],
    [counts, initialSyncComplete]
  );

  return {
    initialLoadItems,
    initialLoadComplete: initialSyncComplete,
    initialSyncComplete,
    restoredFromCache: false,
    loadingStage,
    loading,
    error,
    refetch,
  };
}
