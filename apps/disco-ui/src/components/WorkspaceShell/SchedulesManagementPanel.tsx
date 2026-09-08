import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { Agent, DiscoClient, MCPServer, Schedule, User } from '@disco-live/client';
import { humanizeCron } from '@disco-live/client';
import { Alert, Button, Empty, Popconfirm, Space, Spin, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScheduleModal } from '../ScheduleModal';
import { ScheduleRunsPanel } from '../ScheduleRunsPanel';

interface SchedulesManagementPanelProps {
  client?: DiscoClient | null;
  currentUser?: User | null;
}

function rows<T>(result: T[] | { data: T[] }): T[] {
  return Array.isArray(result) ? result : result.data;
}

function describeCron(cron: string): string {
  try {
    return humanizeCron(cron);
  } catch {
    return cron;
  }
}

export const SchedulesManagementPanel: React.FC<SchedulesManagementPanelProps> = ({
  client,
  currentUser,
}) => {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [runsFor, setRunsFor] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const [scheduleResult, agentResult, mcpResult] = await Promise.all([
        client.service('schedules').find({ query: { $sort: { created_at: -1 } } }),
        client.service('agents').find({ query: { archived: false } }),
        client.service('mcp-servers').find(),
      ]);
      setSchedules(rows(scheduleResult));
      setAgents(rows(agentResult));
      setMcpServers(rows(mcpResult));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '计划任务加载失败');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!client) return;
    const service = client.service('schedules');
    const onCreated = (schedule: Schedule) =>
      setSchedules((current) => [schedule, ...current.filter((item) => item.schedule_id !== schedule.schedule_id)]);
    const onPatched = (schedule: Schedule) =>
      setSchedules((current) =>
        current.map((item) => (item.schedule_id === schedule.schedule_id ? schedule : item))
      );
    const onRemoved = (schedule: Schedule) =>
      setSchedules((current) => current.filter((item) => item.schedule_id !== schedule.schedule_id));
    service.on('created', onCreated);
    service.on('patched', onPatched);
    service.on('removed', onRemoved);
    return () => {
      service.off('created', onCreated);
      service.off('patched', onPatched);
      service.off('removed', onRemoved);
    };
  }, [client]);

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agent_id, agent])),
    [agents]
  );
  const mcpServerById = useMemo(
    () => new Map(mcpServers.map((server) => [server.mcp_server_id, server])),
    [mcpServers]
  );

  const patchEnabled = async (schedule: Schedule, enabled: boolean) => {
    if (!client) return;
    setTogglingId(schedule.schedule_id);
    setError(null);
    try {
      const updated = await client.service('schedules').patch(schedule.schedule_id, { enabled });
      setSchedules((current) =>
        current.map((item) => (item.schedule_id === updated.schedule_id ? updated : item))
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '计划任务状态更新失败');
    } finally {
      setTogglingId(null);
    }
  };

  const runNow = async (schedule: Schedule) => {
    if (!client) return;
    setRunningId(schedule.schedule_id);
    setError(null);
    try {
      await client.service(`schedules/${schedule.schedule_id}/run-now`).create({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '计划任务启动失败');
    } finally {
      setRunningId(null);
    }
  };

  const remove = async (schedule: Schedule) => {
    if (!client) return;
    setError(null);
    try {
      await client.service('schedules').remove(schedule.schedule_id);
      setSchedules((current) => current.filter((item) => item.schedule_id !== schedule.schedule_id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '计划任务删除失败');
    }
  };

  const columns: TableColumnsType<Schedule> = [
    {
      title: '启用',
      width: 68,
      render: (_, schedule) => (
        <Switch
          size="small"
          checked={schedule.enabled}
          loading={togglingId === schedule.schedule_id}
          aria-label={`${schedule.enabled ? '停用' : '启用'} ${schedule.name}`}
          onChange={(enabled) => void patchEnabled(schedule, enabled)}
        />
      ),
    },
    {
      title: '任务',
      render: (_, schedule) => {
        const agent = schedule.agent_id ? agentById.get(schedule.agent_id) : null;
        return (
          <Space orientation="vertical" size={2} style={{ minWidth: 0 }}>
            <Typography.Text strong>{schedule.name}</Typography.Text>
            <Typography.Text type="secondary" ellipsis>
              {describeCron(schedule.cron_expression)} ·{' '}
              {agent
                ? `${agent.emoji ? `${agent.emoji} ` : ''}${agent.display_name}`
                : '独立会话'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '状态',
      width: 112,
      render: (_, schedule) =>
        schedule.last_run_at ? (
          <Tag>{new Date(schedule.last_run_at).toLocaleString()}</Tag>
        ) : (
          <Typography.Text type="secondary">尚未运行</Typography.Text>
        ),
    },
    {
      title: '',
      width: 176,
      align: 'right',
      render: (_, schedule) => (
        <Space size={2}>
          <Button
            type="text"
            aria-label={`立即运行 ${schedule.name}`}
            icon={<PlayCircleOutlined />}
            loading={runningId === schedule.schedule_id}
            disabled={!schedule.enabled}
            onClick={() => void runNow(schedule)}
          />
          <Button
            type="text"
            aria-label={`查看运行记录 ${schedule.name}`}
            icon={<HistoryOutlined />}
            onClick={() => setRunsFor(schedule)}
          />
          <Button
            type="text"
            aria-label={`编辑 ${schedule.name}`}
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(schedule);
              setModalOpen(true);
            }}
          />
          <Popconfirm
            title={`删除“${schedule.name}”？`}
            description="已产生的会话会保留，但计划任务本身将永久删除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(schedule)}
          >
            <Button
              type="text"
              danger
              aria-label={`删除 ${schedule.name}`}
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="disco-settings-scroll-pane" style={{ padding: '4px 6px 28px' }}>
      <div className="disco-settings-panel-heading">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            计划任务
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            按固定时间启动独立会话，或以指定智能体的人格、记忆和技能运行。
          </Typography.Paragraph>
        </div>
        <Space className="disco-schedule-toolbar">
          <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={loading}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            新建
          </Button>
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          closable
          title={error}
          style={{ margin: '14px 0' }}
          onClose={() => setError(null)}
        />
      )}
      {loading ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 260 }}>
          <Spin />
        </div>
      ) : schedules.length === 0 ? (
        <Empty description="还没有计划任务" style={{ marginTop: 72 }} />
      ) : (
        <Table
          className="disco-schedule-table"
          rowKey="schedule_id"
          size="small"
          pagination={false}
          tableLayout="fixed"
          dataSource={schedules}
          columns={columns}
          style={{ marginTop: 16 }}
        />
      )}
      <ScheduleModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        schedule={editing}
        agents={agents}
        mcpServerById={mcpServerById}
        client={client ?? null}
        executionOwner={currentUser}
        currentUser={currentUser}
        onSaved={(saved) =>
          setSchedules((current) => [
            saved,
            ...current.filter((item) => item.schedule_id !== saved.schedule_id),
          ])
        }
      />
      <ScheduleRunsPanel
        open={Boolean(runsFor)}
        schedule={runsFor}
        client={client ?? null}
        onClose={() => setRunsFor(null)}
      />
    </div>
  );
};
