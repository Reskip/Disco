import {
  DeleteOutlined,
  EyeOutlined,
  InboxOutlined,
  LoadingOutlined,
  RedoOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type {
  SessionSearchKind,
  SessionSearchMatch,
  SessionSearchOrder,
  SessionSearchResult,
} from '@disco/core/types';
import type { DiscoClient, Message, Session } from '@disco-live/client';
import {
  Button,
  Drawer,
  Empty,
  Input,
  Pagination,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDiscoPortalContainer } from '../../utils/portalContainer';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { HighlightedSearchText } from './HighlightedSearchText';
import './ArchivedSessionsPanel.css';

export interface ArchivedSessionsPanelProps {
  client?: DiscoClient | null;
  active: boolean;
  initialSessionId?: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const PREVIEW_MESSAGE_LIMIT = 120;

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(
      (block) => block?.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => String((block as unknown as { text: string }).text).trim())
    .filter(Boolean)
    .join('\n');
}

function formatArchiveDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sessionToArchiveEntry(session: Session): SessionSearchMatch {
  return {
    session_id: session.session_id,
    title: getSessionDisplayTitle(session, { includeAgentFallback: false }) || '未命名对话',
    agent_id: session.agent_id,
    archived: Boolean(session.archived),
    status: session.status,
    ready_for_prompt: Boolean(session.ready_for_prompt),
    created_at: session.created_at,
    last_updated: session.last_updated,
    match_kind: 'title',
    snippet: '',
    match_count: 0,
  };
}

export const ArchivedSessionsPanel: React.FC<ArchivedSessionsPanelProps> = ({
  client,
  active,
  initialSessionId,
}) => {
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<SessionSearchKind>('all');
  const [order, setOrder] = useState<SessionSearchOrder>('newest');
  const [afterLocal, setAfterLocal] = useState('');
  const [beforeLocal, setBeforeLocal] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [entries, setEntries] = useState<SessionSearchMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<SessionSearchMatch | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mutationId, setMutationId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);
  const openedInitialIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [active, searchInput]);

  useEffect(() => {
    if (!active || !client) return;
    void reloadToken;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setListError(null);

    const requestQuery: Record<string, unknown> = {
      scope: 'archived',
      kind,
      order,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };
    if (query) requestQuery.q = query;
    const updatedAfter = localDateTimeToIso(afterLocal);
    const updatedBefore = localDateTimeToIso(beforeLocal);
    if (updatedAfter) requestQuery.updated_after = updatedAfter;
    if (updatedBefore) requestQuery.updated_before = updatedBefore;

    void client
      .service('session-search')
      .find({ query: requestQuery })
      .then((response: SessionSearchResult) => {
        if (requestId !== requestIdRef.current) return;
        const maximumPage = Math.max(1, Math.ceil(response.total / pageSize));
        if (page > maximumPage) {
          setPage(maximumPage);
          return;
        }
        setEntries(response.data);
        setTotal(response.total);
      })
      .catch((reason: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setEntries([]);
        setTotal(0);
        setListError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [active, afterLocal, beforeLocal, client, kind, order, page, pageSize, query, reloadToken]);

  useEffect(() => {
    if (!active) {
      openedInitialIdRef.current = null;
      setSelected(null);
      return;
    }
    if (!client || !initialSessionId || openedInitialIdRef.current === initialSessionId) return;
    openedInitialIdRef.current = initialSessionId;
    void client
      .service('sessions')
      .get(initialSessionId)
      .then((session: Session) => {
        if (session.archived) setSelected(sessionToArchiveEntry(session));
      })
      .catch((reason: unknown) => {
        setListError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [active, client, initialSessionId]);

  useEffect(() => {
    if (!active || !client || !selected) {
      setMessages([]);
      setPreviewTruncated(false);
      return;
    }
    let current = true;
    setPreviewLoading(true);
    setPreviewError(null);
    void client
      .service('messages')
      .find({
        query: {
          session_id: selected.session_id,
          $sort: { index: 1 },
          $limit: PREVIEW_MESSAGE_LIMIT,
        },
      })
      .then((response) => {
        if (!current) return;
        const rows = (Array.isArray(response) ? response : response.data) as Message[];
        const humanRows = rows.filter(
          (message) =>
            (message.role === 'user' || message.role === 'assistant') &&
            (message.type === 'user' || message.type === 'assistant') &&
            Boolean(messageText(message))
        );
        setMessages(humanRows);
        setPreviewTruncated(!Array.isArray(response) && response.total > rows.length);
      })
      .catch((reason: unknown) => {
        if (current) setPreviewError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setPreviewLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, client, selected]);

  const refreshArchives = useCallback(() => setReloadToken((value) => value + 1), []);

  const finishMutation = useCallback(() => {
    setSelected(null);
    setMessages([]);
    if (entries.length === 1 && page > 1) setPage((value) => value - 1);
    else refreshArchives();
  }, [entries.length, page, refreshArchives]);

  const restore = async (entry: SessionSearchMatch) => {
    if (!client || mutationId) return;
    setMutationId(entry.session_id);
    setListError(null);
    try {
      await client.service(`sessions/${entry.session_id}/unarchive`).create({
        includeChildren: false,
      });
      finishMutation();
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationId(null);
    }
  };

  const remove = async (entry: SessionSearchMatch) => {
    if (!client || mutationId) return;
    setMutationId(entry.session_id);
    setListError(null);
    try {
      await client.service('sessions').remove(entry.session_id);
      finishMutation();
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationId(null);
    }
  };

  const clearFilters = () => {
    setSearchInput('');
    setQuery('');
    setKind('all');
    setOrder('newest');
    setAfterLocal('');
    setBeforeLocal('');
    setPage(1);
  };

  const hasFilters = Boolean(searchInput || afterLocal || beforeLocal || kind !== 'all');

  return (
    <div className="disco-archives-panel">
      <div className="disco-archives-heading">
        <div>
          <Typography.Title level={3}>已归档会话</Typography.Title>
          <Typography.Text type="secondary">
            批量筛选和整理存档；恢复后才能继续对话。
          </Typography.Text>
        </div>
        <Button
          aria-label="刷新存档"
          icon={<ReloadOutlined />}
          onClick={refreshArchives}
          disabled={loading}
        />
      </div>

      <fieldset className="disco-archives-filters" aria-label="存档筛选">
        <Input
          allowClear
          aria-label="搜索已归档会话"
          prefix={<SearchOutlined />}
          placeholder="搜索标题、消息、附件或智能体"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <fieldset className="disco-archives-date-range" aria-label="最近活动时间范围">
          <Input
            type="datetime-local"
            aria-label="开始时间"
            value={afterLocal}
            max={beforeLocal || undefined}
            onChange={(event) => {
              setAfterLocal(event.target.value);
              setPage(1);
            }}
          />
          <span>至</span>
          <Input
            type="datetime-local"
            aria-label="结束时间"
            value={beforeLocal}
            min={afterLocal || undefined}
            onChange={(event) => {
              setBeforeLocal(event.target.value);
              setPage(1);
            }}
          />
        </fieldset>
        <Select<SessionSearchKind>
          aria-label="会话类型"
          value={kind}
          options={[
            { label: '全部类型', value: 'all' },
            { label: '独立对话', value: 'standalone' },
            { label: '智能体对话', value: 'agent' },
          ]}
          onChange={(value) => {
            setKind(value);
            setPage(1);
          }}
        />
        <Select<SessionSearchOrder>
          aria-label="时间排序"
          value={order}
          options={[
            { label: '最近优先', value: 'newest' },
            { label: '最早优先', value: 'oldest' },
          ]}
          onChange={(value) => {
            setOrder(value);
            setPage(1);
          }}
        />
      </fieldset>

      <div className="disco-archives-summary">
        <Typography.Text type="secondary">共 {total} 段存档</Typography.Text>
        {hasFilters && (
          <Button type="link" size="small" onClick={clearFilters}>
            清除筛选
          </Button>
        )}
      </div>

      {listError && (
        <Typography.Text type="danger" role="alert">
          {listError}
        </Typography.Text>
      )}

      <ul className="disco-archives-list" aria-label="已归档会话列表">
        {loading ? (
          <div className="disco-archives-state">
            <Spin size="small" /> 正在加载…
          </div>
        ) : entries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的存档" />
        ) : (
          entries.map((entry) => (
            <li className="disco-archives-list-item" key={entry.session_id}>
              <button
                type="button"
                className="disco-archives-list-main"
                onClick={() => setSelected(entry)}
              >
                <span className="disco-archives-list-icon">
                  {entry.agent_id ? <RobotOutlined /> : <InboxOutlined />}
                </span>
                <span className="disco-archives-list-copy">
                  <Typography.Text ellipsis strong>
                    <HighlightedSearchText text={entry.title} query={query} />
                  </Typography.Text>
                  {entry.snippet && (
                    <Typography.Text type="secondary" ellipsis>
                      <HighlightedSearchText text={entry.snippet} query={query} />
                    </Typography.Text>
                  )}
                </span>
                <span className="disco-archives-list-meta">
                  <Typography.Text type="secondary" ellipsis>
                    {entry.agent_name ? `智能体 · ${entry.agent_name}` : '独立对话'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {formatArchiveDate(entry.last_updated)}
                  </Typography.Text>
                </span>
              </button>
              <div className="disco-archives-list-actions">
                <Button
                  type="text"
                  size="small"
                  icon={<EyeOutlined />}
                  onClick={() => setSelected(entry)}
                >
                  预览
                </Button>
                <Button
                  type="text"
                  size="small"
                  icon={
                    mutationId === entry.session_id ? <LoadingOutlined spin /> : <RedoOutlined />
                  }
                  disabled={Boolean(mutationId)}
                  onClick={() => void restore(entry)}
                >
                  恢复
                </Button>
                <Popconfirm
                  title="永久删除这段存档？"
                  description="消息和运行记录都会被删除，无法恢复。"
                  okText="永久删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(entry)}
                >
                  <Button
                    danger
                    type="text"
                    size="small"
                    aria-label={`删除存档 ${entry.title}`}
                    icon={<DeleteOutlined />}
                    disabled={Boolean(mutationId)}
                  />
                </Popconfirm>
              </div>
            </li>
          ))
        )}
      </ul>

      {total > 0 && (
        <Pagination
          className="disco-archives-pagination"
          current={page}
          pageSize={pageSize}
          total={total}
          showQuickJumper
          showSizeChanger
          pageSizeOptions={[20, 50, 100]}
          showTotal={(count) => `共 ${count} 条`}
          onChange={(nextPage, nextPageSize) => {
            setPage(nextPageSize === pageSize ? nextPage : 1);
            setPageSize(nextPageSize);
          }}
        />
      )}

      <Drawer
        getContainer={getDiscoPortalContainer}
        rootClassName="disco-archives-preview-drawer"
        title={selected?.title ?? '存档预览'}
        open={Boolean(selected)}
        size={500}
        destroyOnHidden
        onClose={() => setSelected(null)}
      >
        {selected && (
          <>
            <div className="disco-archives-preview-toolbar">
              <div className="disco-archives-preview-meta">
                <Tag variant="filled" icon={selected.agent_id ? <RobotOutlined /> : undefined}>
                  {selected.agent_name || (selected.agent_id ? '智能体对话' : '独立对话')}
                </Tag>
                <Typography.Text type="secondary">
                  {formatArchiveDate(selected.last_updated)}
                </Typography.Text>
              </div>
              <div className="disco-archives-preview-actions">
                <Button
                  size="small"
                  icon={
                    mutationId === selected.session_id ? <LoadingOutlined spin /> : <RedoOutlined />
                  }
                  disabled={Boolean(mutationId)}
                  onClick={() => void restore(selected)}
                >
                  恢复
                </Button>
                <Popconfirm
                  title="永久删除这段存档？"
                  description="消息和运行记录都会被删除，无法恢复。"
                  okText="永久删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(selected)}
                >
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={Boolean(mutationId)}
                  >
                    删除
                  </Button>
                </Popconfirm>
              </div>
            </div>
            <section className="disco-archives-transcript" aria-label="存档预览">
              {previewLoading ? (
                <div className="disco-archives-state">
                  <Spin size="small" /> 正在加载预览…
                </div>
              ) : previewError ? (
                <Typography.Text type="danger" role="alert">
                  {previewError}
                </Typography.Text>
              ) : messages.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="这段会话没有可预览的正文"
                />
              ) : (
                <>
                  {messages.map((message) => (
                    <article
                      key={message.message_id}
                      className={`disco-archives-message is-${message.role}`}
                    >
                      <Typography.Text type="secondary">
                        {message.role === 'user' ? '你' : '智能体'}
                      </Typography.Text>
                      <Typography.Paragraph
                        ellipsis={{ rows: 5, expandable: true, symbol: '展开' }}
                      >
                        {messageText(message)}
                      </Typography.Paragraph>
                    </article>
                  ))}
                  {previewTruncated && (
                    <Typography.Text type="secondary" className="disco-archives-preview-limit">
                      预览仅展示前 {PREVIEW_MESSAGE_LIMIT} 条记录
                    </Typography.Text>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </Drawer>
    </div>
  );
};
