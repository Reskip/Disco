import {
  InboxOutlined,
  MessageOutlined,
  RobotOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type {
  SessionSearchMatch,
  SessionSearchResult,
  SessionSearchScope,
} from '@disco/core/types';
import type { DiscoClient } from '@disco-live/client';
import { Empty, Input, Modal, Segmented, Spin, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDiscoPortalContainer } from '../../utils/portalContainer';
import { HighlightedSearchText } from './HighlightedSearchText';
import './WorkspaceSessionSearchModal.css';

export interface WorkspaceSessionSearchModalProps {
  open: boolean;
  client: DiscoClient | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenArchivedSession: (sessionId: string) => void;
}

const SEARCH_SCOPES: Array<{ label: string; value: SessionSearchScope }> = [
  { label: '全部', value: 'all' },
  { label: '独立对话', value: 'standalone' },
  { label: '智能体', value: 'agent' },
  { label: '已归档', value: 'archived' },
];

function formatSearchDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function ResultIcon({ result }: { result: SessionSearchMatch }) {
  if (result.archived) return <InboxOutlined />;
  if (result.agent_id) return <RobotOutlined />;
  if (result.message_role === 'user') return <UserOutlined />;
  return <MessageOutlined />;
}

export const WorkspaceSessionSearchModal: React.FC<WorkspaceSessionSearchModalProps> = ({
  open,
  client,
  onClose,
  onOpenSession,
  onOpenArchivedSession,
}) => {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SessionSearchScope>('all');
  const [results, setResults] = useState<SessionSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestIdRef = useRef(0);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open || !client || [...normalizedQuery].length < 2) {
      requestIdRef.current += 1;
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void client
        .service('session-search')
        .find({ query: { q: normalizedQuery, scope, limit: 60, offset: 0 } })
        .then((response: SessionSearchResult) => {
          if (requestId !== requestIdRef.current) return;
          setResults(response.data);
          setActiveIndex(0);
        })
        .catch((reason: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setResults([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, 240);

    return () => window.clearTimeout(timer);
  }, [client, normalizedQuery, open, scope]);

  const emptyDescription = useMemo(() => {
    if ([...normalizedQuery].length < 2) return '输入至少两个字开始搜索';
    if (error) return `搜索失败：${error}`;
    return '没有找到匹配的对话';
  }, [error, normalizedQuery]);

  const openResult = (result: SessionSearchMatch | undefined) => {
    if (!result) return;
    if (result.archived) onOpenArchivedSession(result.session_id);
    else onOpenSession(result.session_id);
  };

  return (
    <Modal
      getContainer={getDiscoPortalContainer}
      title="搜索对话"
      open={open}
      width="min(720px, calc(var(--disco-effective-vw, 100vw) - 36px))"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      className="disco-session-search-modal"
    >
      <div className="disco-session-search-controls">
        <Input
          autoFocus
          allowClear
          size="large"
          aria-label="搜索对话"
          prefix={<SearchOutlined />}
          placeholder="搜索标题、消息、附件或智能体"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault();
              setActiveIndex((previous) => (previous + 1) % results.length);
            } else if (event.key === 'ArrowUp' && results.length > 0) {
              event.preventDefault();
              setActiveIndex((previous) => (previous - 1 + results.length) % results.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              openResult(results[activeIndex]);
            }
          }}
        />
        <Segmented
          aria-label="搜索范围"
          block
          value={scope}
          options={SEARCH_SCOPES}
          onChange={(value) => {
            setScope(value as SessionSearchScope);
            setActiveIndex(0);
          }}
        />
      </div>

      <div className="disco-session-search-results" role="listbox" aria-label="搜索结果">
        {loading ? (
          <div className="disco-session-search-state" role="status">
            <Spin size="small" />
            <span>正在搜索…</span>
          </div>
        ) : results.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
        ) : (
          results.map((result, index) => (
            <button
              key={result.session_id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`disco-session-search-result${index === activeIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => openResult(result)}
            >
              <span className="disco-session-search-result-icon">
                <ResultIcon result={result} />
              </span>
              <span className="disco-session-search-result-copy">
                <span className="disco-session-search-result-title">
                  <Typography.Text ellipsis strong>
                    <HighlightedSearchText text={result.title} query={normalizedQuery} />
                  </Typography.Text>
                  {result.archived && <Tag variant="filled">已归档</Tag>}
                  {(result.status === 'running' || result.status === 'stopping') && (
                    <Tag variant="filled" color="processing">
                      运行中
                    </Tag>
                  )}
                  {result.ready_for_prompt &&
                    result.status !== 'running' &&
                    result.status !== 'stopping' && (
                      <Tag variant="filled" color="gold">
                        未读
                      </Tag>
                    )}
                </span>
                <Typography.Text type="secondary" ellipsis>
                  <HighlightedSearchText text={result.snippet} query={normalizedQuery} />
                </Typography.Text>
                <span className="disco-session-search-result-meta">
                  <Typography.Text type="secondary">
                    {result.agent_name ? (
                      <>
                        智能体 ·{' '}
                        <HighlightedSearchText text={result.agent_name} query={normalizedQuery} />
                      </>
                    ) : (
                      '独立对话'
                    )}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {formatSearchDate(result.last_updated)}
                  </Typography.Text>
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      <Typography.Text type="secondary" className="disco-session-search-hint">
        ↑↓ 选择 · Enter 打开 · Esc 关闭
      </Typography.Text>
    </Modal>
  );
};
