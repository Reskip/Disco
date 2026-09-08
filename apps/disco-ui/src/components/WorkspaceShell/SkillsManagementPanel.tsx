import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  CloudSyncOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { CodexSkillCatalogEntry } from '@disco-live/client';
import { Alert, Button, Empty, Input, Modal, Segmented, Spin, Switch, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { getDiscoPortalContainer } from '@/utils/portalContainer';

type SkillSourceFilter = 'all' | 'codex-sync' | 'disco-local';
type SkillStatusFilter = 'all' | 'enabled' | 'disabled';

interface SkillsManagementPanelProps {
  skills: CodexSkillCatalogEntry[];
  skillsLoading: boolean;
  skillsError: string | null;
  onDismissError: () => void;
  canManageSkill: (skill: CodexSkillCatalogEntry) => boolean;
  skillSourceFilter: SkillSourceFilter;
  onSkillSourceFilterChange: (value: SkillSourceFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  togglingId: string | null;
  onToggleSkill: (skill: CodexSkillCatalogEntry, enabled: boolean) => void;
  onUninstallSkill: (skill: CodexSkillCatalogEntry) => Promise<boolean>;
  onRefreshShared: () => void;
}

function SkillSourceTag({ source }: { source: CodexSkillCatalogEntry['source'] }) {
  if (source === 'disco-local') return <Tag color="gold">Disco 本地</Tag>;
  if (source === 'agent-generated') return <Tag color="purple">智能体生成</Tag>;
  return <Tag>Codex 官方同步</Tag>;
}

export function SkillsManagementPanel({
  skills,
  skillsLoading,
  skillsError,
  onDismissError,
  canManageSkill,
  skillSourceFilter,
  onSkillSourceFilterChange,
  search,
  onSearchChange,
  togglingId,
  onToggleSkill,
  onUninstallSkill,
  onRefreshShared,
}: SkillsManagementPanelProps) {
  const [skillStatusFilter, setSkillStatusFilter] = useState<SkillStatusFilter>('all');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [uninstallSkill, setUninstallSkill] = useState<CodexSkillCatalogEntry | null>(null);
  const [uninstallConfirmation, setUninstallConfirmation] = useState('');
  const [uninstalling, setUninstalling] = useState(false);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const sharedSkills = useMemo(
    () => skills.filter((skill) => skill.source !== 'agent-generated'),
    [skills]
  );
  const visibleSkills = useMemo(
    () =>
      sharedSkills.filter((skill) => {
        if (skillSourceFilter !== 'all' && skill.source !== skillSourceFilter) return false;
        if (skillStatusFilter === 'enabled' && !skill.enabled) return false;
        if (skillStatusFilter === 'disabled' && skill.enabled) return false;
        if (!normalizedSearch) return true;
        return `${skill.name} ${skill.description} ${skill.source_detail}`
          .toLocaleLowerCase()
          .includes(normalizedSearch);
      }),
    [normalizedSearch, sharedSkills, skillSourceFilter, skillStatusFilter]
  );
  useEffect(() => {
    if (visibleSkills.some((skill) => skill.id === selectedSkillId)) return;
    setSelectedSkillId(visibleSkills[0]?.id ?? null);
    setMobileDetailOpen(false);
  }, [selectedSkillId, visibleSkills]);

  const selectedSkill = visibleSkills.find((skill) => skill.id === selectedSkillId) ?? null;
  const enabledSkillCount = sharedSkills.filter((skill) => skill.enabled && skill.available).length;
  const availableSkillCount = sharedSkills.filter((skill) => skill.available).length;

  return (
    <div className="disco-settings-scroll-pane disco-capability-center">
      <header className="disco-capability-heading">
        <div>
          <Typography.Title level={4}>技能管理</Typography.Title>
          <Typography.Paragraph type="secondary">
            管理所有账号共享的 Codex 同步技能与 Disco
            本地技能。智能体自己的设定、记忆和能力请从该智能体的“编辑智能体”进入。
          </Typography.Paragraph>
        </div>
      </header>

      {skillsError && (
        <Alert
          showIcon
          closable
          type="error"
          title="技能数据加载失败"
          description={skillsError}
          onClose={onDismissError}
        />
      )}

      <section className="disco-capability-workspace" aria-label="共享技能库">
        <div className="disco-capability-toolbar">
          <Segmented
            value={skillSourceFilter}
            onChange={(value) => onSkillSourceFilterChange(value as SkillSourceFilter)}
            options={[
              { label: '全部来源', value: 'all' },
              { label: 'Codex', value: 'codex-sync' },
              { label: 'Disco', value: 'disco-local' },
            ]}
          />
          <Segmented
            value={skillStatusFilter}
            onChange={(value) => setSkillStatusFilter(value as SkillStatusFilter)}
            options={[
              { label: '全部状态', value: 'all' },
              { label: '已启用', value: 'enabled' },
              { label: '已停用', value: 'disabled' },
            ]}
          />
          <Input
            allowClear
            value={search}
            prefix={<SearchOutlined />}
            placeholder="搜索技能"
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <Button
            type="text"
            aria-label="刷新共享技能"
            icon={<ReloadOutlined />}
            loading={skillsLoading}
            onClick={onRefreshShared}
          />
        </div>
        <div className="disco-capability-overview-line">
          <span>
            <b>{enabledSkillCount}</b> 项启用
          </span>
          <span>{availableSkillCount} 项可用</span>
          <span>Codex 官方技能由管理员管理；Disco 技能由安装者或管理员管理</span>
        </div>
        <Spin spinning={skillsLoading}>
          <div
            className={`disco-skill-manager-shell ${
              mobileDetailOpen ? 'is-mobile-detail' : 'is-mobile-list'
            }`}
          >
            <ul className="disco-skill-dense-list" aria-label="共享技能列表">
              {visibleSkills.length === 0 && !skillsLoading ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={search ? '没有符合条件的技能' : '尚未发现共享技能'}
                />
              ) : (
                visibleSkills.map((skill) => (
                  <li
                    key={skill.id}
                    className={`${selectedSkillId === skill.id ? 'is-selected' : ''}${
                      skill.available ? '' : ' is-unavailable'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSkillId(skill.id);
                        setMobileDetailOpen(true);
                      }}
                    >
                      <span className="disco-skill-row-icon" aria-hidden>
                        {skill.source === 'disco-local' ? (
                          <AppstoreOutlined />
                        ) : (
                          <CloudSyncOutlined />
                        )}
                      </span>
                      <span className="disco-skill-row-copy">
                        <span>
                          <strong>{skill.name}</strong>
                          <SkillSourceTag source={skill.source} />
                        </span>
                        <small>{skill.unavailable_reason || skill.description || '暂无说明'}</small>
                      </span>
                    </button>
                    <Switch
                      size="small"
                      aria-label={`启用 ${skill.name}`}
                      checked={skill.enabled}
                      loading={togglingId === skill.id}
                      disabled={!canManageSkill(skill) || !skill.available || togglingId !== null}
                      onChange={(checked) => onToggleSkill(skill, checked)}
                    />
                  </li>
                ))
              )}
            </ul>
            <aside className="disco-capability-detail" aria-label="共享技能详情">
              <Button
                type="text"
                className="disco-capability-mobile-back"
                aria-label="返回技能列表"
                icon={<ArrowLeftOutlined />}
                onClick={() => setMobileDetailOpen(false)}
              >
                返回列表
              </Button>
              {selectedSkill ? (
                <>
                  <div className="disco-capability-detail-title">
                    <span className="disco-capability-card-icon" aria-hidden>
                      {selectedSkill.source === 'disco-local' ? (
                        <AppstoreOutlined />
                      ) : (
                        <CloudSyncOutlined />
                      )}
                    </span>
                    <div>
                      <Typography.Title level={5}>{selectedSkill.name}</Typography.Title>
                      <SkillSourceTag source={selectedSkill.source} />
                    </div>
                  </div>
                  <Typography.Paragraph type="secondary">
                    {selectedSkill.unavailable_reason || selectedSkill.description || '暂无说明'}
                  </Typography.Paragraph>
                  <div className="disco-capability-detail-path">
                    <span>来源位置</span>
                    <code>{selectedSkill.source_detail}</code>
                  </div>
                  <div className="disco-capability-detail-toggle">
                    <div>
                      <strong>{selectedSkill.enabled ? '允许调用' : '禁止调用'}</strong>
                      <small>
                        {selectedSkill.available
                          ? '新任务会立即采用这个设置'
                          : '当前运行环境不可用'}
                      </small>
                    </div>
                    <Switch
                      aria-label={`详情中启用 ${selectedSkill.name}`}
                      checked={selectedSkill.enabled}
                      loading={togglingId === selectedSkill.id}
                      disabled={
                        !canManageSkill(selectedSkill) ||
                        !selectedSkill.available ||
                        togglingId !== null
                      }
                      onChange={(checked) => onToggleSkill(selectedSkill, checked)}
                    />
                  </div>
                  {selectedSkill.source === 'disco-local' && selectedSkill.lifecycle && (
                    <div className="disco-capability-detail-actions">
                      <Typography.Text type="secondary">
                        版本 {selectedSkill.lifecycle.version} · 安装记录与卸载审计会保留
                      </Typography.Text>
                      <Button
                        danger
                        type="text"
                        icon={<AppstoreOutlined />}
                        disabled={!canManageSkill(selectedSkill) || togglingId !== null}
                        onClick={() => {
                          setUninstallConfirmation('');
                          setUninstallSkill(selectedSkill);
                        }}
                      >
                        卸载技能
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个技能查看详情" />
              )}
            </aside>
          </div>
        </Spin>
      </section>
      <Modal
        getContainer={getDiscoPortalContainer}
        title={`卸载技能 · ${uninstallSkill?.name ?? ''}`}
        open={Boolean(uninstallSkill)}
        centered
        destroyOnHidden
        okText="永久卸载"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          loading: uninstalling,
          disabled:
            !uninstallSkill || uninstallConfirmation.trim() !== uninstallSkill.name,
        }}
        onCancel={() => {
          if (uninstalling) return;
          setUninstallSkill(null);
          setUninstallConfirmation('');
        }}
        onOk={() => {
          if (!uninstallSkill || uninstallConfirmation.trim() !== uninstallSkill.name) return;
          setUninstalling(true);
          void onUninstallSkill(uninstallSkill)
            .then((removed) => {
              if (!removed) return;
              setUninstallSkill(null);
              setUninstallConfirmation('');
            })
            .finally(() => setUninstalling(false));
        }}
      >
        <Typography.Paragraph type="secondary">
          运行文件会被删除，名称、版本、来源、操作者和时间会保留在审计记录中。
        </Typography.Paragraph>
        <Typography.Paragraph>
          请输入技能名称 <Typography.Text code>{uninstallSkill?.name}</Typography.Text> 以确认：
        </Typography.Paragraph>
        <Input
          autoFocus
          aria-label="输入技能名称以确认卸载"
          value={uninstallConfirmation}
          disabled={uninstalling}
          status={
            uninstallConfirmation && uninstallConfirmation.trim() !== uninstallSkill?.name
              ? 'error'
              : undefined
          }
          onChange={(event) => setUninstallConfirmation(event.target.value)}
        />
      </Modal>
    </div>
  );
}
