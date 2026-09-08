import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  SaveOutlined,
  SmileOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type {
  Agent,
  AgentCapabilityEntry,
  AgentCapabilityKind,
  DiscoClient,
} from '@disco-live/client';
import {
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Tabs,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDiscoPortalContainer } from '@/utils/portalContainer';
import { cropAvatarImage } from '../../utils/avatarImage';
import { useThemedMessage } from '../../utils/message';
import { COMMON_AGENT_EMOJIS } from './agentEmojis';
import './WorkspaceAgentEditModal.css';

interface BasicFormValues {
  displayName: string;
  description?: string;
}

export interface WorkspaceAgentEditModalProps {
  open: boolean;
  client: DiscoClient | null;
  agent: Agent | null;
  onDeleteAgent: (agentId: string, confirmation: string) => void | Promise<void>;
  onClose: () => void;
}

const PROFILE_LABELS: Record<string, string> = {
  'AGENTS.md': '工作区规则',
  '.disco/IDENTITY.md': '身份',
  '.disco/RESPONSIBILITIES.md': '长期职责',
  '.disco/SOUL.md': '性格与原则',
  '.disco/USER.md': '用户偏好',
};

const RESPONSIBILITY_SUMMARY_START = '<!-- disco:summary:start -->';
const RESPONSIBILITY_SUMMARY_END = '<!-- disco:summary:end -->';

export function syncAgentIdentity(content: string, displayName: string): string {
  const nextLine = `- 名称：${displayName}`;
  if (/^- 名称：.*$/mu.test(content)) return content.replace(/^- 名称：.*$/mu, nextLine);
  const heading = content.match(/^# .+$/mu);
  if (!heading?.index && heading?.index !== 0) return `# 身份\n\n${nextLine}\n\n${content}`;
  const insertAt = heading.index + heading[0].length;
  return `${content.slice(0, insertAt)}\n\n${nextLine}${content.slice(insertAt)}`;
}

export function syncAgentWorkspaceName(content: string, displayName: string): string {
  if (/你是“[^”]*”/u.test(content)) return content.replace(/你是“[^”]*”/u, `你是“${displayName}”`);
  return content;
}

export function syncAgentResponsibilitySummary(
  content: string,
  summary: string,
  previousSummary?: string
): string {
  const normalizedSummary = summary.trim() || '根据用户后续指示维护自己的长期职责。';
  const managedBlock = `${RESPONSIBILITY_SUMMARY_START}\n## 当前职责摘要\n\n${normalizedSummary}\n${RESPONSIBILITY_SUMMARY_END}`;
  const managedExpression = new RegExp(
    `${RESPONSIBILITY_SUMMARY_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RESPONSIBILITY_SUMMARY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'u'
  );
  if (managedExpression.test(content)) return content.replace(managedExpression, managedBlock);

  const headingMatch = content.match(/^# .+$/mu);
  const existingBody = headingMatch
    ? content.slice((headingMatch.index ?? 0) + headingMatch[0].length).trim()
    : content.trim();
  const replaceableSummaries = new Set(
    [previousSummary?.trim(), '根据用户后续指示维护自己的长期职责。'].filter(Boolean)
  );
  if (!existingBody || replaceableSummaries.has(existingBody)) {
    return `# 长期职责\n\n${managedBlock}\n`;
  }
  if (!headingMatch) return `# 长期职责\n\n${managedBlock}\n\n${content.trim()}\n`;
  const insertAt = (headingMatch.index ?? 0) + headingMatch[0].length;
  return `${content.slice(0, insertAt)}\n\n${managedBlock}\n${content.slice(insertAt).replace(/^\s*/u, '\n')}`;
}

function entryLabel(entry: AgentCapabilityEntry): string {
  return PROFILE_LABELS[entry.relative_path] || entry.name;
}

function skillConfirmationName(entry: AgentCapabilityEntry | null): string {
  return entry?.lifecycle?.name || entry?.name || '';
}

function AgentDocumentManager({
  kind,
  entries,
  loading,
  busyId,
  onRefresh,
  onPatch,
  onDelete,
}: {
  kind: AgentCapabilityKind;
  entries: AgentCapabilityEntry[];
  loading: boolean;
  busyId: string | null;
  onRefresh: () => void;
  onPatch: (
    entry: AgentCapabilityEntry,
    patch: { content?: string; enabled?: boolean },
    options?: { silent?: boolean }
  ) => Promise<boolean>;
  onDelete: (entry: AgentCapabilityEntry) => Promise<void>;
}) {
  const filtered = useMemo(() => entries.filter((entry) => entry.kind === kind), [entries, kind]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
  const [draft, setDraft] = useState(selected?.content ?? '');
  const [editing, setEditing] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(true);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    setDraft(selected?.id ? (selected.content ?? '') : '');
    setEditing(false);
  }, [selected?.content, selected?.id]);

  return (
    <div
      className={`disco-agent-document-manager ${
        mobileListOpen ? 'is-mobile-list' : 'is-mobile-detail'
      }`}
    >
      <aside className="disco-agent-document-list" aria-label={`${kind} 文件列表`}>
        <div className="disco-agent-document-list-head">
          <Typography.Text type="secondary">
            {kind === 'profile' ? '核心资料' : kind === 'memory' ? '记忆文件' : '智能体技能'}
          </Typography.Text>
          <Button
            type="text"
            size="small"
            aria-label="刷新智能体资料"
            icon={<ReloadOutlined />}
            onClick={onRefresh}
          />
        </div>
        <Spin spinning={loading}>
          {filtered.length === 0 && !loading ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无内容" />
          ) : (
            filtered.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === selected?.id ? 'is-active' : ''}
                onClick={() => {
                  setSelectedId(entry.id);
                  setMobileListOpen(false);
                }}
              >
                <span>
                  <strong>{entryLabel(entry)}</strong>
                  {entry.description && <small>{entry.description}</small>}
                </span>
                {!entry.enabled && <em>停用</em>}
              </button>
            ))
          )}
        </Spin>
      </aside>
      <section className="disco-agent-document-editor">
        {selected ? (
          <>
            <header>
              <Button
                type="text"
                aria-label="返回列表"
                icon={<ArrowLeftOutlined />}
                className="disco-agent-document-mobile-back"
                onClick={() => setMobileListOpen(true)}
              >
                返回列表
              </Button>
              <div className="disco-agent-document-title">
                <Typography.Title level={5}>{entryLabel(selected)}</Typography.Title>
              </div>
              <div className="disco-agent-document-enable">
                <span>{selected.enabled ? '参与后续任务' : '当前已停用'}</span>
                <Switch
                  size="small"
                  aria-label="参与后续任务"
                  checked={selected.enabled}
                  loading={busyId === selected.id}
                  disabled={busyId !== null}
                  onChange={(checked) =>
                    void onPatch(selected, { enabled: checked }, { silent: true })
                  }
                />
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`编辑${entryLabel(selected)}`}
                  aria-hidden={editing}
                  tabIndex={editing ? -1 : 0}
                  className={editing ? 'disco-edit-trigger is-placeholder' : 'disco-edit-trigger'}
                  onClick={() => setEditing(true)}
                >
                  编辑
                </Button>
              </div>
            </header>
            <Input.TextArea
              aria-label={`${entryLabel(selected)}内容`}
              value={draft}
              readOnly={!editing}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />
            <footer className={editing ? 'is-editing' : 'is-placeholder'} aria-hidden={!editing}>
              {editing && (
                <>
                  <Typography.Text type="secondary">
                    修改从下一次任务开始生效，不影响正在运行的对话。
                  </Typography.Text>
                  <div>
                    {selected.removable && (
                      <Popconfirm
                        title={`${selected.kind === 'skill' ? '卸载' : '删除'}“${entryLabel(selected)}”？`}
                        okText={selected.kind === 'skill' ? '继续卸载' : '删除'}
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDelete(selected)}
                      >
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          disabled={busyId !== null}
                        >
                          {selected.kind === 'skill' ? '卸载' : '删除'}
                        </Button>
                      </Popconfirm>
                    )}
                    <Button
                      aria-label={`取消编辑${entryLabel(selected)}`}
                      disabled={busyId !== null}
                      onClick={() => {
                        setDraft(selected.content);
                        setEditing(false);
                      }}
                    >
                      取消
                    </Button>
                    <Button
                      type="primary"
                      icon={<SaveOutlined />}
                      loading={busyId === selected.id}
                      disabled={
                        busyId !== null && busyId !== selected.id
                          ? true
                          : draft === selected.content
                      }
                      onClick={() =>
                        void onPatch(selected, {
                          content: draft,
                        }).then((saved) => {
                          if (saved) setEditing(false);
                        })
                      }
                    >
                      保存
                    </Button>
                  </div>
                </>
              )}
            </footer>
          </>
        ) : (
          <Empty description="选择一项进行查看和编辑" />
        )}
      </section>
    </div>
  );
}

export function WorkspaceAgentEditModal({
  open,
  client,
  agent,
  onDeleteAgent,
  onClose,
}: WorkspaceAgentEditModalProps) {
  const [form] = Form.useForm<BasicFormValues>();
  const { showError, showSuccess } = useThemedMessage();
  const [activeTab, setActiveTab] = useState('basic');
  const [entries, setEntries] = useState<AgentCapabilityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingBasic, setSavingBasic] = useState(false);
  const [basicEditing, setBasicEditing] = useState(false);
  const [emoji, setEmoji] = useState('🤖');
  const [avatarUrl, setAvatarUrl] = useState<string>();
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [pendingSkillUninstall, setPendingSkillUninstall] = useState<AgentCapabilityEntry | null>(
    null
  );
  const [skillUninstallConfirmation, setSkillUninstallConfirmation] = useState('');
  const [uninstallingSkill, setUninstallingSkill] = useState(false);

  const loadEntries = useCallback(async () => {
    if (!client || !agent) return;
    setLoading(true);
    try {
      const result = await client.service('agent-capabilities').find({
        query: { agent_id: agent.agent_id },
      });
      setEntries(Array.isArray(result) ? (result as AgentCapabilityEntry[]) : []);
    } catch (error) {
      showError(`加载智能体资料失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [agent, client, showError]);

  const resetBasicDraft = useCallback(() => {
    if (!agent) return;
    form.setFieldsValue({
      displayName: agent.display_name,
      description: agent.description || undefined,
    });
    setEmoji(agent.emoji || '🤖');
    setAvatarUrl(agent.avatar_url || undefined);
  }, [agent, form]);

  useEffect(() => {
    if (!open || !agent) return;
    resetBasicDraft();
    setBasicEditing(false);
    setActiveTab('basic');
    setEmojiPickerOpen(false);
    setDeleteConfirmation('');
    setPendingSkillUninstall(null);
    setSkillUninstallConfirmation('');
    void loadEntries();
  }, [agent, loadEntries, open, resetBasicDraft]);

  const saveBasic = useCallback(async () => {
    if (!client || !agent) return;
    const values = await form.validateFields();

    setSavingBasic(true);
    try {
      await client.service('agents').patch(agent.agent_id, {
        display_name: values.displayName.trim(),
        description: values.description?.trim() || null,
        avatar_url: avatarUrl || null,
        emoji: avatarUrl ? null : emoji,
      });
      const profilePatches = entries
        .map((entry): { entry: AgentCapabilityEntry; content: string } | null => {
          if (entry.relative_path === 'AGENTS.md') {
            return {
              entry,
              content: syncAgentWorkspaceName(entry.content, values.displayName.trim()),
            };
          }
          if (entry.relative_path === '.disco/IDENTITY.md') {
            return { entry, content: syncAgentIdentity(entry.content, values.displayName.trim()) };
          }
          if (entry.relative_path === '.disco/RESPONSIBILITIES.md') {
            return {
              entry,
              content: syncAgentResponsibilitySummary(
                entry.content,
                values.description?.trim() || '',
                agent.description?.trim()
              ),
            };
          }
          return null;
        })
        .filter((patch): patch is { entry: AgentCapabilityEntry; content: string } =>
          Boolean(patch)
        )
        .filter((patch) => patch.content !== patch.entry.content);
      const updatedProfiles = await Promise.all(
        profilePatches.map(
          ({ entry, content }) =>
            client
              .service('agent-capabilities')
              .patch(
                entry.id,
                { content },
                { query: { agent_id: agent.agent_id } }
              ) as Promise<AgentCapabilityEntry>
        )
      );
      if (updatedProfiles.length > 0) {
        const updatedById = new Map(updatedProfiles.map((entry) => [entry.id, entry]));
        setEntries((previous) => previous.map((entry) => updatedById.get(entry.id) ?? entry));
      }
      showSuccess('智能体资料已保存');
      setBasicEditing(false);
    } catch (error) {
      showError(`保存智能体失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingBasic(false);
    }
  }, [agent, avatarUrl, client, emoji, entries, form, showError, showSuccess]);

  const patchEntry = useCallback(
    async (
      entry: AgentCapabilityEntry,
      patch: { content?: string; enabled?: boolean },
      options?: { silent?: boolean }
    ) => {
      if (!client || !agent) return false;
      setBusyId(entry.id);
      try {
        const updated = (await client.service('agent-capabilities').patch(entry.id, patch, {
          query: { agent_id: agent.agent_id },
        })) as AgentCapabilityEntry;
        setEntries((previous) => previous.map((item) => (item.id === entry.id ? updated : item)));
        if (!options?.silent) showSuccess('已保存');
        return true;
      } catch (error) {
        showError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [agent, client, showError, showSuccess]
  );

  const deleteEntry = useCallback(
    async (entry: AgentCapabilityEntry) => {
      if (!client || !agent) return;
      if (entry.kind === 'skill' && entry.lifecycle) {
        setSkillUninstallConfirmation('');
        setPendingSkillUninstall(entry);
        return;
      }
      setBusyId(entry.id);
      try {
        await client.service('agent-capabilities').remove(entry.id, {
          query: { agent_id: agent.agent_id },
        });
        setEntries((previous) => previous.filter((item) => item.id !== entry.id));
        showSuccess('已删除');
      } catch (error) {
        showError(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusyId(null);
      }
    },
    [agent, client, showError, showSuccess]
  );

  const uninstallAgentSkill = useCallback(async () => {
    if (
      !client ||
      !agent ||
      !pendingSkillUninstall?.lifecycle ||
      skillUninstallConfirmation.trim() !== skillConfirmationName(pendingSkillUninstall)
    ) {
      return;
    }
    setUninstallingSkill(true);
    setBusyId(pendingSkillUninstall.id);
    try {
      await client.service('agent-capabilities').patch(
        pendingSkillUninstall.id,
        {
          action: 'uninstall',
          confirmation: skillConfirmationName(pendingSkillUninstall),
        },
        { query: { agent_id: agent.agent_id } }
      );
      setEntries((previous) => previous.filter((item) => item.id !== pendingSkillUninstall.id));
      setPendingSkillUninstall(null);
      setSkillUninstallConfirmation('');
      showSuccess('技能已卸载，审计记录已保留');
    } catch (error) {
      showError(`卸载失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyId(null);
      setUninstallingSkill(false);
    }
  }, [agent, client, pendingSkillUninstall, showError, showSuccess, skillUninstallConfirmation]);

  const documentPanel = (kind: AgentCapabilityKind) => (
    <AgentDocumentManager
      kind={kind}
      entries={entries}
      loading={loading}
      busyId={busyId}
      onRefresh={() => void loadEntries()}
      onPatch={patchEntry}
      onDelete={deleteEntry}
    />
  );

  const title = agent?.display_name || '智能体';
  const requiredDeleteConfirmation = `删除智能体 ${title}`;
  const deleteConfirmationMatches = deleteConfirmation.trim() === requiredDeleteConfirmation;

  const deleteAgent = useCallback(async () => {
    if (!agent || deletingAgent || !deleteConfirmationMatches) return;
    setDeletingAgent(true);
    try {
      await onDeleteAgent(agent.agent_id, requiredDeleteConfirmation);
      setDeleteConfirmation('');
      onClose();
    } catch (error) {
      showError(`删除智能体失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingAgent(false);
    }
  }, [
    agent,
    deleteConfirmationMatches,
    deletingAgent,
    onClose,
    onDeleteAgent,
    requiredDeleteConfirmation,
    showError,
  ]);

  return (
    <>
      <Modal
        getContainer={getDiscoPortalContainer}
        title={`编辑智能体 · ${title}`}
        open={open && Boolean(agent)}
        centered
        width="min(920px, calc(var(--disco-effective-vw, 100vw) - 32px))"
        footer={null}
        onCancel={onClose}
        destroyOnHidden
        className="disco-agent-edit-modal"
        styles={{
          body: {
            height: 'min(540px, calc(var(--disco-effective-vh, 100vh) - 112px))',
            minHeight: 0,
            overflow: 'hidden',
          },
        }}
      >
        <div className="disco-agent-mobile-nav">
          <Typography.Text type="secondary">智能体设置页面</Typography.Text>
          <Select
            aria-label="智能体设置页面"
            value={activeTab}
            options={[
              { value: 'basic', label: '基础资料' },
              { value: 'profile', label: '核心设定' },
              { value: 'memory', label: '长期记忆' },
              { value: 'skill', label: '技能' },
              { value: 'danger', label: '删除智能体' },
            ]}
            onChange={setActiveTab}
          />
        </div>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'basic',
              label: '基础资料',
              children: (
                <div className="disco-agent-basic-panel">
                  <div className="disco-agent-edit-section-heading">
                    <div>
                      <Typography.Title level={5}>基础资料</Typography.Title>
                      <Typography.Text type="secondary">编辑头像、名称和职责摘要。</Typography.Text>
                    </div>
                    <Button
                      type="text"
                      icon={<EditOutlined />}
                      aria-label="编辑基础资料"
                      aria-hidden={basicEditing}
                      tabIndex={basicEditing ? -1 : 0}
                      className={
                        basicEditing ? 'disco-edit-trigger is-placeholder' : 'disco-edit-trigger'
                      }
                      onClick={() => setBasicEditing(true)}
                    >
                      编辑
                    </Button>
                  </div>
                  <Form<BasicFormValues> form={form} layout="vertical" requiredMark={false}>
                    <div className="disco-agent-edit-avatar-row">
                      <Avatar size={74} src={avatarUrl} className="disco-agent-avatar-circle">
                        {!avatarUrl && emoji}
                      </Avatar>
                      <div>
                        <Typography.Text strong>头像</Typography.Text>
                        <Typography.Text type="secondary">
                          使用 Emoji，或上传后自动居中裁剪成圆形图片。
                        </Typography.Text>
                        <div>
                          <Button
                            icon={<SmileOutlined />}
                            disabled={!basicEditing}
                            onClick={() => setEmojiPickerOpen(true)}
                          >
                            选择 Emoji
                          </Button>
                          <Upload
                            accept="image/*"
                            disabled={!basicEditing}
                            showUploadList={false}
                            beforeUpload={(file) => {
                              setUploadingAvatar(true);
                              void cropAvatarImage(file)
                                .then(setAvatarUrl)
                                .catch((error) =>
                                  showError(error instanceof Error ? error.message : '头像处理失败')
                                )
                                .finally(() => setUploadingAvatar(false));
                              return Upload.LIST_IGNORE;
                            }}
                          >
                            <Button
                              icon={<UploadOutlined />}
                              loading={uploadingAvatar}
                              disabled={!basicEditing}
                            >
                              上传图片
                            </Button>
                          </Upload>
                        </div>
                      </div>
                    </div>
                    <Form.Item
                      name="displayName"
                      label="智能体名称"
                      rules={[{ required: true, whitespace: true, message: '请输入智能体名称' }]}
                    >
                      <Input maxLength={64} autoComplete="off" disabled={!basicEditing} />
                    </Form.Item>
                    <Form.Item name="description" label="职责摘要">
                      <Input.TextArea
                        autoSize={{ minRows: 3, maxRows: 5 }}
                        disabled={!basicEditing}
                      />
                    </Form.Item>
                    <div
                      className={`disco-agent-basic-actions${basicEditing ? ' is-editing' : ''}`}
                      aria-hidden={!basicEditing}
                    >
                      {basicEditing && (
                        <div>
                          <Button
                            aria-label="取消编辑基础资料"
                            disabled={savingBasic}
                            onClick={() => {
                              resetBasicDraft();
                              setBasicEditing(false);
                            }}
                          >
                            取消
                          </Button>
                          <Button
                            type="primary"
                            loading={savingBasic}
                            onClick={() => void saveBasic()}
                          >
                            保存基础资料
                          </Button>
                        </div>
                      )}
                    </div>
                  </Form>
                </div>
              ),
            },
            { key: 'profile', label: '核心设定', children: documentPanel('profile') },
            { key: 'memory', label: '长期记忆', children: documentPanel('memory') },
            { key: 'skill', label: '技能', children: documentPanel('skill') },
            {
              key: 'danger',
              label: '删除智能体',
              children: (
                <div className="disco-agent-danger-panel">
                  <div className="disco-agent-danger-content">
                    <Typography.Title level={4}>永久删除“{title}”</Typography.Title>
                    <Typography.Paragraph type="secondary">
                      删除后，这个智能体的全部对话、长期记忆、能力资料和工作区文件都会一并移除，且无法恢复。
                    </Typography.Paragraph>
                    <Typography.Text strong>请输入以下确认文本：</Typography.Text>
                    <Typography.Text code copyable>
                      {requiredDeleteConfirmation}
                    </Typography.Text>
                    <Input
                      value={deleteConfirmation}
                      status={
                        deleteConfirmation && !deleteConfirmationMatches ? 'error' : undefined
                      }
                      placeholder={requiredDeleteConfirmation}
                      autoComplete="off"
                      disabled={deletingAgent}
                      onChange={(event) => setDeleteConfirmation(event.target.value)}
                    />
                    <Popconfirm
                      title="最终确认删除这个智能体？"
                      description="此操作不可撤销。"
                      okText="永久删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true, loading: deletingAgent }}
                      disabled={!deleteConfirmationMatches || deletingAgent}
                      onConfirm={() => void deleteAgent()}
                    >
                      <Button
                        danger
                        type="primary"
                        icon={<DeleteOutlined />}
                        loading={deletingAgent}
                        disabled={!deleteConfirmationMatches || deletingAgent}
                      >
                        删除智能体
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Modal>
      <Modal
        getContainer={getDiscoPortalContainer}
        title={`卸载技能 · ${pendingSkillUninstall?.name ?? ''}`}
        open={open && Boolean(pendingSkillUninstall)}
        centered
        destroyOnHidden
        okText="永久卸载"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          loading: uninstallingSkill,
          disabled:
            !pendingSkillUninstall ||
            skillUninstallConfirmation.trim() !== skillConfirmationName(pendingSkillUninstall),
        }}
        onCancel={() => {
          if (uninstallingSkill) return;
          setPendingSkillUninstall(null);
          setSkillUninstallConfirmation('');
        }}
        onOk={() => void uninstallAgentSkill()}
      >
        <Typography.Paragraph type="secondary">
          运行文件会被删除；技能名称、版本、来源、操作者和时间会继续保留在审计记录中。
        </Typography.Paragraph>
        <Typography.Paragraph>
          请输入技能名称{' '}
          <Typography.Text code>{skillConfirmationName(pendingSkillUninstall)}</Typography.Text>{' '}
          以确认：
        </Typography.Paragraph>
        <Input
          autoFocus
          aria-label="输入智能体技能名称以确认卸载"
          value={skillUninstallConfirmation}
          disabled={uninstallingSkill}
          status={
            skillUninstallConfirmation &&
            skillUninstallConfirmation.trim() !== skillConfirmationName(pendingSkillUninstall)
              ? 'error'
              : undefined
          }
          onChange={(event) => setSkillUninstallConfirmation(event.target.value)}
        />
      </Modal>
      <Modal
        getContainer={getDiscoPortalContainer}
        title="选择智能体头像"
        open={open && emojiPickerOpen}
        centered
        width={430}
        footer={null}
        onCancel={() => setEmojiPickerOpen(false)}
        destroyOnHidden
        className="disco-agent-emoji-modal"
      >
        <ul className="disco-agent-emoji-grid" aria-label="选择智能体头像">
          {COMMON_AGENT_EMOJIS.map((candidate) => (
            <li key={candidate}>
              <Tooltip title={`使用 ${candidate}`} mouseEnterDelay={0.2}>
                <button
                  type="button"
                  aria-label={`使用 ${candidate} 作为头像`}
                  aria-pressed={!avatarUrl && emoji === candidate}
                  className={`disco-agent-emoji-option${
                    !avatarUrl && emoji === candidate ? ' is-selected' : ''
                  }`}
                  onClick={() => {
                    setEmoji(candidate);
                    setAvatarUrl(undefined);
                    setEmojiPickerOpen(false);
                  }}
                >
                  {candidate}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
