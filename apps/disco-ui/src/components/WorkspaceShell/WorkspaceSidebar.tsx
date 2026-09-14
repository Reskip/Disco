import {
  CaretDownOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  EditOutlined,
  InboxOutlined,
  LoadingOutlined,
  LogoutOutlined,
  MoreOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { Agent, Session, User } from '@disco-live/client';
import {
  Avatar,
  Button,
  ConfigProvider,
  Dropdown,
  Input,
  Modal,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalTheme } from '../../contexts/ThemeContext';
import { useDiscoStore } from '../../store/discoStore';
import { selectSessionById } from '../../store/selectors';
import { getDiscoPortalContainer } from '../../utils/portalContainer';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { BrandMark } from '../BrandMark';
import './WorkspaceSidebar.css';

interface AgentGroup {
  agent: Agent;
  sessions: Session[];
}

export interface WorkspaceSidebarProps {
  mobileOpen?: boolean;
  mobile?: boolean;
  currentUser?: User | null;
  agents: Agent[];
  selectedSessionId?: string | null;
  loading?: boolean;
  creating?: boolean;
  connected?: boolean;
  onGoHome?: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewStandalone: () => void | Promise<void>;
  onTalkToAgent: (agentId: string) => void | Promise<void>;
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onArchiveSession?: (sessionId: string) => void | Promise<void>;
  onEditAgent: (agentId: string) => void;
  onOpenSettings: () => void;
  onOpenSearch?: () => void;
  onLogout?: () => void;
}

const byRecent = (a: Session, b: Session) =>
  new Date(b.last_updated || b.created_at).getTime() -
  new Date(a.last_updated || a.created_at).getTime();

const SIDEBAR_STATE_KEY_PREFIX = 'disco:workspace-sidebar:';
const DEFAULT_VISIBLE_SESSIONS = 5;

interface StoredSidebarState {
  collapsedStandalone?: boolean;
  collapsedAgentsSection?: boolean;
  collapsedAgents?: string[];
  expandedSessionGroups?: string[];
}

function readStoredSidebarState(userId?: string): StoredSidebarState {
  if (!userId || typeof window === 'undefined') return {};
  try {
    const value = window.localStorage.getItem(`${SIDEBAR_STATE_KEY_PREFIX}${userId}`);
    return value ? (JSON.parse(value) as StoredSidebarState) : {};
  } catch {
    return {};
  }
}

function statusSummary(sessions: Session[], selectedSessionId?: string | null): string {
  const running = sessions.filter(
    (session) => session.status === 'running' || session.status === 'stopping'
  ).length;
  const unread = sessions.filter(
    (session) => session.session_id !== selectedSessionId && session.ready_for_prompt === true
  ).length;
  return [running > 0 ? `${running} 运行中` : '', unread > 0 ? `${unread} 未读` : '']
    .filter(Boolean)
    .join(' · ');
}

function limitedSessions(
  sessions: Session[],
  expanded: boolean,
  selectedSessionId?: string | null
): { visible: Session[]; hiddenCount: number } {
  if (expanded || sessions.length <= DEFAULT_VISIBLE_SESSIONS) {
    return { visible: sessions, hiddenCount: 0 };
  }
  const visibleIds = new Set(
    sessions.slice(0, DEFAULT_VISIBLE_SESSIONS).map((item) => item.session_id)
  );
  for (const session of sessions) {
    if (
      session.session_id === selectedSessionId ||
      session.status === 'running' ||
      session.status === 'stopping' ||
      session.ready_for_prompt === true
    ) {
      visibleIds.add(session.session_id);
    }
  }
  return {
    visible: sessions.filter((session) => visibleIds.has(session.session_id)),
    hiddenCount: sessions.filter((session) => !visibleIds.has(session.session_id)).length,
  };
}

function SessionRow({
  session,
  selected,
  indent = 28,
  onClick,
  onRename,
  onDelete,
  onArchive,
  actionsEnabled = true,
  editing,
  renameDraft,
  renameSaving,
  onRenameDraftChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  session: Session;
  selected: boolean;
  indent?: number;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  onArchive: () => void;
  actionsEnabled?: boolean;
  editing: boolean;
  renameDraft: string;
  renameSaving: boolean;
  onRenameDraftChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}) {
  const { token } = theme.useToken();
  const running = session.status === 'running' || session.status === 'stopping';
  const unread = !selected && !running && session.ready_for_prompt === true;
  const cancelOnBlurRef = useRef(false);
  useEffect(() => {
    if (editing) cancelOnBlurRef.current = false;
  }, [editing]);
  return (
    <div
      className={`disco-workspace-session-row${selected ? ' is-selected' : ''}`}
      style={{
        width: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        borderRadius: 9,
        background: selected ? token.colorPrimaryBg : 'transparent',
        color: selected ? token.colorPrimaryText : token.colorText,
      }}
    >
      {editing ? (
        <div className="disco-workspace-session-inline-edit" style={{ paddingLeft: indent }}>
          <Input
            autoFocus
            size="small"
            variant="borderless"
            maxLength={100}
            value={renameDraft}
            disabled={renameSaving}
            aria-label="编辑对话标题"
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onBlur={() => {
              if (!cancelOnBlurRef.current) onRenameSubmit();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                onRenameSubmit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelOnBlurRef.current = true;
                onRenameCancel();
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="disco-workspace-session-select"
          onClick={onClick}
          style={{ paddingLeft: indent }}
        >
          <Typography.Text ellipsis className="disco-workspace-session-title">
            {getSessionDisplayTitle(session, { includeAgentFallback: false }) || '未命名对话'}
          </Typography.Text>
        </button>
      )}
      {running ? (
        <span
          className="disco-workspace-session-status is-running"
          role="status"
          aria-label="任务运行中"
        >
          <LoadingOutlined spin />
        </span>
      ) : unread ? (
        <span
          className="disco-workspace-session-status is-unread"
          role="status"
          aria-label="有未读完成结果"
        />
      ) : null}
      {!editing && actionsEnabled && (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'rename', icon: <EditOutlined />, label: '重命名' },
              { key: 'archive', icon: <InboxOutlined />, label: '归档' },
              { type: 'divider' },
              { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation();
              if (key === 'rename') onRename();
              if (key === 'archive') onArchive();
              if (key === 'delete') onDelete();
            },
          }}
        >
          <Button
            type="text"
            size="small"
            shape="circle"
            className="disco-workspace-row-action"
            aria-label="对话操作"
            icon={<MoreOutlined />}
            onClick={(event) => event.stopPropagation()}
          />
        </Dropdown>
      )}
    </div>
  );
}

export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  mobileOpen = false,
  mobile = false,
  currentUser,
  agents,
  selectedSessionId,
  loading = false,
  creating = false,
  connected = false,
  onGoHome,
  onSelectSession,
  onNewStandalone,
  onTalkToAgent,
  onRenameSession,
  onDeleteSession,
  onArchiveSession,
  onEditAgent,
  onOpenSettings,
  onOpenSearch,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const isDark = useOptionalTheme()?.isDark ?? false;
  const sessionById = useDiscoStore(selectSessionById);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const [collapsedStandalone, setCollapsedStandalone] = useState(false);
  const [collapsedAgentsSection, setCollapsedAgentsSection] = useState(false);
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(() => new Set());
  const [loadedSidebarOwner, setLoadedSidebarOwner] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [mutationInFlight, setMutationInFlight] = useState(false);
  const renameSaveInFlightRef = useRef(false);

  useEffect(() => {
    const owner = currentUser?.user_id ?? null;
    const stored = readStoredSidebarState(owner ?? undefined);
    setCollapsedStandalone(Boolean(stored.collapsedStandalone));
    setCollapsedAgentsSection(Boolean(stored.collapsedAgentsSection));
    setCollapsedAgents(new Set(stored.collapsedAgents ?? []));
    setExpandedSessionGroups(new Set(stored.expandedSessionGroups ?? []));
    setLoadedSidebarOwner(owner);
  }, [currentUser?.user_id]);

  useEffect(() => {
    const owner = currentUser?.user_id ?? null;
    if (!owner || loadedSidebarOwner !== owner || typeof window === 'undefined') return;
    const stored: StoredSidebarState = {
      collapsedStandalone,
      collapsedAgentsSection,
      collapsedAgents: [...collapsedAgents],
      expandedSessionGroups: [...expandedSessionGroups],
    };
    window.localStorage.setItem(`${SIDEBAR_STATE_KEY_PREFIX}${owner}`, JSON.stringify(stored));
  }, [
    collapsedAgents,
    collapsedAgentsSection,
    collapsedStandalone,
    currentUser?.user_id,
    expandedSessionGroups,
    loadedSidebarOwner,
  ]);

  const { standaloneSessions, agentGroups } = useMemo(() => {
    const sessions = Array.from(sessionById.values()).filter(
      (session) =>
        !session.archived && (!currentUser?.user_id || session.created_by === currentUser.user_id)
    );
    const sessionsByAgent = new Map<string, Session[]>();
    for (const session of sessions) {
      if (!session.agent_id) continue;
      const list = sessionsByAgent.get(session.agent_id) ?? [];
      list.push(session);
      sessionsByAgent.set(session.agent_id, list);
    }
    for (const list of sessionsByAgent.values()) list.sort(byRecent);

    const groups: AgentGroup[] = agents
      .filter(
        (agent) =>
          !agent.archived && (!currentUser?.user_id || agent.created_by === currentUser.user_id)
      )
      .map((agent) => ({ agent, sessions: sessionsByAgent.get(agent.agent_id) ?? [] }))
      .sort((a, b) => a.agent.display_name.localeCompare(b.agent.display_name));
    const standalone = sessions.filter((session) => !session.agent_id);
    standalone.sort(byRecent);

    return { standaloneSessions: standalone, agentGroups: groups };
  }, [agents, currentUser?.user_id, sessionById]);

  const selectedStandalone = standaloneSessions.some(
    (session) => session.session_id === selectedSessionId
  );
  const standaloneExpanded = !collapsedStandalone || selectedStandalone;
  const standaloneLimited = limitedSessions(
    standaloneSessions,
    expandedSessionGroups.has('standalone'),
    selectedSessionId
  );
  const selectedAgentSession = agentGroups.some((group) =>
    group.sessions.some((session) => session.session_id === selectedSessionId)
  );
  const agentsSectionExpanded = !collapsedAgentsSection || selectedAgentSession;

  const toggleAgent = (agentId: string) => {
    setCollapsedAgents((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const showAllSessions = (group: string) => {
    setExpandedSessionGroups((previous) => new Set(previous).add(group));
  };

  const archiveSession = async (session: Session) => {
    if (mutationInFlight) return;
    setMutationInFlight(true);
    try {
      await onArchiveSession?.(session.session_id);
    } catch {
      // The app-level mutation handler reports the localized error.
    } finally {
      setMutationInFlight(false);
    }
  };

  // Repository-free Disco workspaces are created on demand. Requiring a legacy
  // repo here disabled the primary action for perfectly healthy new accounts.
  const workspaceReady = connected;

  const openRename = (session: Session) => {
    setRenameTarget(session);
    setRenameDraft(
      getSessionDisplayTitle(session, { includeAgentFallback: false }) || '未命名对话'
    );
  };

  const saveRename = async () => {
    const title = renameDraft.trim();
    if (!renameTarget || mutationInFlight || renameSaveInFlightRef.current) return;
    if (!title) {
      setRenameTarget(null);
      return;
    }
    renameSaveInFlightRef.current = true;
    setMutationInFlight(true);
    try {
      await onRenameSession(renameTarget.session_id, title);
      setRenameTarget(null);
    } catch {
      // The app-level mutation handler already reports the localized error.
    } finally {
      renameSaveInFlightRef.current = false;
      setMutationInFlight(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || mutationInFlight) return;
    setMutationInFlight(true);
    try {
      await onDeleteSession(deleteTarget.session_id);
      setDeleteTarget(null);
    } catch {
      // Keep the confirmation open so the user can retry after the reported error.
    } finally {
      setMutationInFlight(false);
    }
  };

  return (
    <aside
      className={`disco-workspace-sidebar${mobileOpen ? ' is-mobile-open' : ''}`}
      style={{
        height: '100%',
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgLayout,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ padding: '10px 12px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <button
            type="button"
            className="disco-workspace-brand-home"
            aria-label="返回主页"
            onClick={onGoHome}
          >
            <BrandMark size={60} />
            <Typography.Text strong>Disco</Typography.Text>
          </button>
          {creating && <Spin size="small" />}
          {!mobile && (
            <>
              <Tooltip title="搜索对话（Ctrl/⌘ K）">
                <Button
                  type="text"
                  shape="circle"
                  aria-label="搜索对话"
                  icon={<SearchOutlined />}
                  onClick={onOpenSearch}
                />
              </Tooltip>
              <Tooltip title="设置">
                <Button
                  type="text"
                  shape="circle"
                  aria-label="打开设置"
                  icon={<SettingOutlined />}
                  onClick={onOpenSettings}
                />
              </Tooltip>
            </>
          )}
        </div>
        <Tooltip title={workspaceReady ? undefined : '本地工作区尚未就绪'}>
          <Button
            block
            type="text"
            size="middle"
            className="disco-workspace-new-chat"
            aria-label="新建独立对话"
            icon={<PlusOutlined />}
            disabled={creating || !workspaceReady}
            onClick={() => void onNewStandalone()}
            style={{
              background: token.colorPrimaryBg,
              color: token.colorPrimaryText,
            }}
          >
            新建独立对话
          </Button>
        </Tooltip>
      </div>

      <div
        className="disco-workspace-sidebar-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 14px' }}
      >
        <button
          type="button"
          className="disco-workspace-section-heading disco-workspace-section-toggle"
          aria-expanded={standaloneExpanded}
          onClick={() => setCollapsedStandalone((previous) => !previous)}
        >
          <span>
            {standaloneExpanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
            <Typography.Text type="secondary">独立对话</Typography.Text>
          </span>
          {!standaloneExpanded && statusSummary(standaloneSessions, selectedSessionId) && (
            <Typography.Text type="secondary">
              {statusSummary(standaloneSessions, selectedSessionId)}
            </Typography.Text>
          )}
        </button>
        {standaloneExpanded &&
          (standaloneSessions.length > 0 ? (
            <>
              {standaloneLimited.visible.map((session) => (
                <SessionRow
                  key={session.session_id}
                  session={session}
                  selected={session.session_id === selectedSessionId}
                  onClick={() => onSelectSession(session.session_id)}
                  onRename={() => openRename(session)}
                  onArchive={() => void archiveSession(session)}
                  onDelete={() => setDeleteTarget(session)}
                  actionsEnabled={!mobile}
                  editing={renameTarget?.session_id === session.session_id}
                  renameDraft={renameDraft}
                  renameSaving={mutationInFlight}
                  onRenameDraftChange={setRenameDraft}
                  onRenameSubmit={() => void saveRename()}
                  onRenameCancel={() => setRenameTarget(null)}
                />
              ))}
              {standaloneLimited.hiddenCount > 0 && (
                <button
                  type="button"
                  className="disco-workspace-show-more"
                  onClick={() => showAllSessions('standalone')}
                >
                  显示其余 {standaloneLimited.hiddenCount} 段对话
                </button>
              )}
            </>
          ) : loading ? (
            <div className="disco-workspace-loading-row" role="status">
              <Spin size="small" />
              <span>正在加载对话列表…</span>
            </div>
          ) : (
            <Typography.Text className="disco-workspace-empty-row" type="secondary">
              暂无独立对话
            </Typography.Text>
          ))}

        <button
          type="button"
          className="disco-workspace-section-heading disco-workspace-section-toggle"
          aria-expanded={agentsSectionExpanded}
          onClick={() => setCollapsedAgentsSection((previous) => !previous)}
        >
          <span>
            {agentsSectionExpanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
            <Typography.Text type="secondary">智能体</Typography.Text>
          </span>
          {!agentsSectionExpanded &&
            statusSummary(
              agentGroups.flatMap((group) => group.sessions),
              selectedSessionId
            ) && (
              <Typography.Text type="secondary">
                {statusSummary(
                  agentGroups.flatMap((group) => group.sessions),
                  selectedSessionId
                )}
              </Typography.Text>
            )}
        </button>

        {agentsSectionExpanded &&
          (agentGroups.length > 0 ? (
            agentGroups.map(({ agent, sessions }) => {
              const name = agent.display_name;
              const containsSelection = sessions.some(
                (session) => session.session_id === selectedSessionId
              );
              const expanded = !collapsedAgents.has(agent.agent_id) || containsSelection;
              const groupLimited = limitedSessions(
                sessions,
                expandedSessionGroups.has(`agent:${agent.agent_id}`),
                selectedSessionId
              );
              return (
                <div key={agent.agent_id} className="disco-workspace-agent-group">
                  <div className="disco-workspace-agent-row">
                    <button
                      type="button"
                      className="disco-workspace-agent-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleAgent(agent.agent_id)}
                    >
                      {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
                      <Avatar
                        size={22}
                        src={agent.avatar_url || undefined}
                        className="disco-workspace-agent-avatar"
                      >
                        {!agent.avatar_url && (agent.emoji || <RobotOutlined />)}
                      </Avatar>
                      <Typography.Text ellipsis>{name}</Typography.Text>
                      {!expanded && statusSummary(sessions, selectedSessionId) && (
                        <Typography.Text type="secondary" className="disco-workspace-group-status">
                          {statusSummary(sessions, selectedSessionId)}
                        </Typography.Text>
                      )}
                    </button>
                    <Tooltip title={`与 ${name} 开始新对话`}>
                      <Button
                        type="text"
                        size="small"
                        shape="circle"
                        aria-label={`与 ${name} 开始新对话`}
                        icon={<PlusOutlined />}
                        disabled={creating}
                        onClick={() => void onTalkToAgent(agent.agent_id)}
                      />
                    </Tooltip>
                    {!mobile && (
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        menu={{
                          items: [
                            {
                              key: 'edit',
                              icon: <EditOutlined />,
                              label: '编辑智能体',
                            },
                          ],
                          onClick: ({ domEvent }) => {
                            domEvent.stopPropagation();
                            onEditAgent(agent.agent_id);
                          },
                        }}
                      >
                        <Button
                          type="text"
                          size="small"
                          shape="circle"
                          className="disco-workspace-agent-more"
                          aria-label={`${name} 的操作`}
                          icon={<MoreOutlined />}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </Dropdown>
                    )}
                  </div>
                  {expanded && (
                    <div className="disco-workspace-agent-sessions">
                      {sessions.length > 0 ? (
                        <>
                          {groupLimited.visible.map((session) => (
                            <SessionRow
                              key={session.session_id}
                              session={session}
                              selected={session.session_id === selectedSessionId}
                              indent={34}
                              onClick={() => onSelectSession(session.session_id)}
                              onRename={() => openRename(session)}
                              onArchive={() => void archiveSession(session)}
                              onDelete={() => setDeleteTarget(session)}
                              actionsEnabled={!mobile}
                              editing={renameTarget?.session_id === session.session_id}
                              renameDraft={renameDraft}
                              renameSaving={mutationInFlight}
                              onRenameDraftChange={setRenameDraft}
                              onRenameSubmit={() => void saveRename()}
                              onRenameCancel={() => setRenameTarget(null)}
                            />
                          ))}
                          {groupLimited.hiddenCount > 0 && (
                            <button
                              type="button"
                              className="disco-workspace-show-more is-agent"
                              onClick={() => showAllSessions(`agent:${agent.agent_id}`)}
                            >
                              显示其余 {groupLimited.hiddenCount} 段对话
                            </button>
                          )}
                        </>
                      ) : loading ? (
                        <div className="disco-workspace-loading-row is-agent" role="status">
                          <Spin size="small" />
                          <span>正在加载对话…</span>
                        </div>
                      ) : (
                        <Typography.Text
                          className="disco-workspace-empty-row is-agent"
                          type="secondary"
                        >
                          暂无对话
                        </Typography.Text>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : loading ? (
            <div className="disco-workspace-loading-row" role="status">
              <Spin size="small" />
              <span>正在加载智能体…</span>
            </div>
          ) : (
            <Typography.Text className="disco-workspace-empty-row" type="secondary">
              暂无智能体
            </Typography.Text>
          ))}
      </div>

      <div className="disco-workspace-account">
        <ConfigProvider
          theme={{
            components: {
              Dropdown: isDark
                ? {
                    // Use a restrained red that stays readable on the dark menu surface.
                    colorError: token.colorErrorTextHover,
                    colorTextLightSolid: token.colorBgContainer,
                  }
                : {},
            },
          }}
        >
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            getPopupContainer={(trigger) => trigger.parentElement ?? getDiscoPortalContainer()}
            classNames={{
              root: `disco-workspace-account-menu${mobile ? ' disco-workspace-mobile-account-menu' : ''}`,
            }}
            styles={{ item: { minHeight: mobile ? 44 : token.controlHeight } }}
            menu={{
              style: {
                // Keep a subtle separation from the sidebar without a bright panel.
                background: isDark
                  ? `linear-gradient(${token.colorFillQuaternary}, ${token.colorFillQuaternary}), ${token.colorBgElevated}`
                  : token.colorBgElevated,
                border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadius,
                boxShadow: token.boxShadowSecondary,
                padding: token.paddingXXS,
              },
              items: mobile
                ? [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true }]
                : [
                    { key: 'settings', icon: <SettingOutlined />, label: '设置' },
                    { type: 'divider' },
                    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
                  ],
              onClick: ({ key }) => {
                if (key === 'settings') onOpenSettings();
                if (key === 'logout') onLogout?.();
              },
            }}
          >
            <Button
              type="text"
              block={!mobile}
              className={`disco-workspace-account-button${mobile ? ' is-mobile' : ''}`}
              aria-label={mobile ? '打开账号菜单' : undefined}
            >
              <Avatar
                size={28}
                src={currentUser?.avatar_url || undefined}
                style={{ background: token.colorFillSecondary, color: token.colorText }}
              >
                {!currentUser?.avatar_url && (currentUser?.emoji || <UserOutlined />)}
              </Avatar>
              {!mobile && (
                <span style={{ minWidth: 0, textAlign: 'left' }}>
                  <Typography.Text
                    ellipsis
                    style={{ display: 'block', maxWidth: 170, fontSize: 13 }}
                  >
                    {currentUser?.name || currentUser?.username || '用户'}
                  </Typography.Text>
                  <Typography.Text type="secondary" className="disco-workspace-account-caption">
                    账号与设置
                  </Typography.Text>
                </span>
              )}
            </Button>
          </Dropdown>
        </ConfigProvider>
      </div>

      <Modal
        getContainer={getDiscoPortalContainer}
        title="删除这段对话？"
        open={deleteTarget !== null}
        okText="删除"
        cancelText="取消"
        confirmLoading={mutationInFlight}
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        onCancel={() => {
          if (!mutationInFlight) setDeleteTarget(null);
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          “
          {deleteTarget
            ? getSessionDisplayTitle(deleteTarget, { includeAgentFallback: false })
            : ''}
          ” 的消息和运行记录将被永久删除，此操作无法撤销。
        </Typography.Paragraph>
      </Modal>
    </aside>
  );
};
