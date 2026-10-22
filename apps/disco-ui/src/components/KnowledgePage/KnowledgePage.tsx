import {
  ArrowLeftOutlined,
  BookOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type {
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeLibraryStatus,
  KnowledgeListResult,
} from '@disco/core/types';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  List,
  Pagination,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KnowledgeEntryDrawer } from './KnowledgeEntryDrawer';
import { KnowledgeImportActions } from './KnowledgeImportActions';
import { knowledgeApi } from './knowledgeApi';
import {
  errorMessage,
  formatDate,
  INDEX_LABELS,
  KIND_LABELS,
  PARSE_LABELS,
  SOURCE_LABELS,
} from './knowledgePresentation';

export function KnowledgePage({
  mobile = false,
  entryId,
  onGoHome,
}: {
  mobile?: boolean;
  entryId?: string | null;
  onGoHome: () => void;
}) {
  const { token } = theme.useToken();
  const { modal, message } = AntApp.useApp();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<KnowledgeListResult | null>(null);
  const [status, setStatus] = useState<KnowledgeLibraryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(entryId || null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<KnowledgeEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const dirty =
    editing &&
    (!detail
      ? Boolean(title || markdown)
      : title !== detail?.entry.title || markdown !== detail?.markdown);

  useEffect(() => {
    setSelectedId(entryId || null);
    setCreating(false);
  }, [entryId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed mutation invalidates the list and status together.
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      const [listResult, statusResult] = await Promise.allSettled([
        knowledgeApi.list(query, source, offset, controller.signal),
        knowledgeApi.status(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (listResult.status === 'fulfilled') {
        setResult(listResult.value);
        setError(null);
      } else {
        setError(errorMessage(listResult.reason));
      }
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
      else if (listResult.status === 'fulfilled')
        setError('资料已加载，暂时无法获取后台同步状态。');
      setLoading(false);
      pending = false;
    };
    setLoading(true);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [query, source, offset, revision]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const requestId = ++detailRequestRef.current;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setEditing(false);
    void knowledgeApi.detail(selectedId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted || requestId !== detailRequestRef.current) return;
        setDetail(value);
        setTitle(value.entry.title);
        setMarkdown(value.markdown);
        setDetailLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted || requestId !== detailRequestRef.current) return;
        setDetailError(errorMessage(cause));
        setDetailLoading(false);
      }
    );
    return () => controller.abort();
  }, [selectedId]);

  const closeDetail = useCallback(() => {
    if (saving) return;
    const close = () => {
      ++detailRequestRef.current;
      setSelectedId(null);
      setCreating(false);
      setEditing(false);
      setDetail(null);
      setDetailError(null);
    };
    if (dirty) {
      modal.confirm({
        title: '放弃尚未保存的修改？',
        content: '关闭后，本次编辑的草稿不会保存。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: close,
      });
    } else close();
  }, [dirty, modal, saving]);

  const save = async () => {
    if (!title.trim() || saving || (!creating && !detail)) return;
    setSaving(true);
    setDetailError(null);
    try {
      const saved = !detail
        ? await knowledgeApi.create(title.trim(), markdown)
        : await knowledgeApi.save(
            detail!.entry.id,
            title.trim(),
            markdown,
            detail!.entry.updatedAt
          );
      setDetail(saved);
      setTitle(saved.entry.title);
      setMarkdown(saved.markdown);
      setEditing(false);
      setRevision((value) => value + 1);
      // Keep a newly created note in this drawer without a second detail request.
      void message.success('已保存，检索索引将在后台更新');
    } catch (cause) {
      setDetailError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = (entry: KnowledgeEntry) => {
    modal.confirm({
      title: `从知识库删除“${entry.title}”？`,
      content: (
        <Space orientation="vertical">
          <Typography.Text>
            将删除这份知识库归档及其检索索引。原会话和原始资料不受影响。
          </Typography.Text>
          <Typography.Text>后续自动同步不会重新导入这份记录。</Typography.Text>
          {entry.humanEdited && (
            <Typography.Text type="warning">这份资料包含人工编辑的内容。</Typography.Text>
          )}
        </Space>
      ),
      okText: '删除知识库记录',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeletingId(entry.id);
        try {
          await knowledgeApi.remove(entry.id);
          if (detail?.entry.id === entry.id) {
            setSelectedId(null);
            setCreating(false);
            setEditing(false);
            setDetail(null);
          }
          setOffset(0);
          setRevision((value) => value + 1);
          void message.success('已从知识库删除');
        } catch (cause) {
          void message.error(errorMessage(cause));
          throw cause;
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <main
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          padding: mobile ? `${token.paddingLG}px ${token.padding}px` : token.paddingXL,
        }}
      >
        <Flex
          justify="space-between"
          align="center"
          wrap
          gap={token.marginSM}
          style={{ marginBottom: token.marginLG, paddingLeft: mobile ? token.controlHeightLG : 0 }}
        >
          <Space>
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              aria-label="返回主页"
              onClick={onGoHome}
            />
            <Typography.Title level={3} style={{ margin: 0 }}>
              知识库
            </Typography.Title>
          </Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setSelectedId(null);
              setCreating(true);
              setDetail(null);
              setDetailError(null);
              setDetailLoading(false);
              setTitle('');
              setMarkdown('');
              setEditing(true);
            }}
          >
            新建笔记
          </Button>
        </Flex>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            会话归档与资料独立保留。直接编辑 Markdown 后自动同步，人工修改不会被自动总结覆盖。
          </Typography.Paragraph>
          <KnowledgeImportActions onChanged={() => setRevision((value) => value + 1)} />
          {status && (
            <Card size="small">
              <Flex wrap justify="space-between" gap={token.marginSM}>
                <Space wrap size="middle">
                  <Typography.Text>
                    <BookOutlined /> {status.total} 份资料
                  </Typography.Text>
                  <Typography.Text type="secondary">{status.conversations} 段会话</Typography.Text>
                  <Typography.Text type="secondary">{status.documents} 份文档</Typography.Text>
                  <Typography.Text type="secondary">{status.notes} 篇笔记</Typography.Text>
                  <Typography.Text type="secondary">{status.pendingIndex} 份待索引</Typography.Text>
                </Space>
                <Typography.Text
                  role="status"
                  aria-live="polite"
                  type={status.sync?.state === 'error' ? 'danger' : 'secondary'}
                >
                  {status.sync?.message ||
                    (status.sync?.state === 'running'
                      ? '正在导入历史资料…'
                      : status.sync?.lastCompletedAt
                        ? `最近同步 ${formatDate(status.sync.lastCompletedAt)}`
                        : '后台自动同步')}
                  {status.sync?.state === 'running' &&
                    Boolean(status.sync.processed) &&
                    ` · 已处理 ${status.sync.processed} 份`}
                </Typography.Text>
              </Flex>
              {status.engine && status.engine.status !== 'ready' && (
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginTop: token.marginSM, marginBottom: 0 }}
                >
                  {status.engine.message || '语义检索暂不可用，资料归档与关键词查找仍可使用。'}
                </Typography.Paragraph>
              )}
            </Card>
          )}
          <Flex wrap gap={token.marginSM}>
            <Input
              value={search}
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索标题或正文"
              aria-label="搜索知识库"
              onChange={(event) => setSearch(event.target.value)}
              style={{ flex: '1 1 240px', fontSize: mobile ? 16 : undefined }}
            />
            <Select
              aria-label="资料来源"
              value={source}
              onChange={(value) => {
                setSource(value);
                setOffset(0);
              }}
              style={{ minWidth: 160, fontSize: mobile ? 16 : undefined }}
              options={[
                { value: 'all', label: '全部来源' },
                ...Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
          </Flex>
          {error && (
            <Alert type="warning" showIcon title={error} description="连接恢复后会自动重试。" />
          )}
          <Card styles={{ body: { padding: `0 ${token.paddingLG}px` } }}>
            {loading && !result ? (
              <Skeleton active paragraph={{ rows: 6 }} style={{ paddingBlock: token.paddingLG }} />
            ) : (
              <List
                loading={loading}
                dataSource={result?.entries ?? []}
                locale={{
                  emptyText: error ? (
                    <Empty description="资料暂时无法加载" />
                  ) : (
                    <Empty
                      description={
                        query || source !== 'all'
                          ? '没有找到匹配的资料'
                          : '还没有资料，历史会话将在后台导入，也可以先写一篇笔记。'
                      }
                    />
                  ),
                }}
                renderItem={(entry) => (
                  <List.Item>
                    <Flex
                      style={{ width: '100%', minWidth: 0 }}
                      gap={token.marginSM}
                      align="center"
                    >
                      <FileTextOutlined
                        style={{ color: token.colorTextSecondary, fontSize: token.fontSizeLG }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Button
                          type="link"
                          onClick={() => {
                            setCreating(false);
                            setSelectedId(entry.id);
                          }}
                          style={{
                            padding: 0,
                            maxWidth: '100%',
                            height: 'auto',
                            whiteSpace: 'normal',
                            textAlign: 'left',
                          }}
                        >
                          {entry.title || '未命名资料'}
                        </Button>
                        {entry.snippet && (
                          <Typography.Paragraph
                            type="secondary"
                            ellipsis={{ rows: 2 }}
                            style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}
                          >
                            {entry.snippet}
                          </Typography.Paragraph>
                        )}
                        <Flex
                          wrap
                          align="center"
                          gap={token.marginXS}
                          style={{ marginTop: token.marginXS }}
                        >
                          <Typography.Text type="secondary">
                            {SOURCE_LABELS[entry.source]} · {KIND_LABELS[entry.kind]}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {formatDate(entry.updatedAt)}
                          </Typography.Text>
                          {entry.humanEdited && <Tag>人工编辑</Tag>}
                          <Tag color={entry.indexStatus === 'error' ? 'error' : undefined}>
                            {INDEX_LABELS[entry.indexStatus]}
                          </Tag>
                          {entry.parseStatus && entry.parseStatus !== 'parsed' && (
                            <Tag color={entry.parseStatus === 'error' ? 'warning' : undefined}>
                              {PARSE_LABELS[entry.parseStatus]}
                            </Tag>
                          )}
                        </Flex>
                      </div>
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`删除 ${entry.title}`}
                        loading={deletingId === entry.id}
                        onClick={() => removeEntry(entry)}
                      />
                    </Flex>
                  </List.Item>
                )}
              />
            )}
          </Card>
          {(result?.total ?? 0) > 20 && (
            <Pagination
              current={Math.floor(offset / 20) + 1}
              total={result?.total ?? 0}
              pageSize={20}
              showSizeChanger={false}
              size={mobile ? 'small' : undefined}
              onChange={(page) => setOffset((page - 1) * 20)}
            />
          )}
        </Space>
      </main>
      <KnowledgeEntryDrawer
        open={Boolean(selectedId) || creating}
        mobile={mobile}
        editing={editing}
        saving={saving}
        title={title}
        markdown={markdown}
        detail={detail}
        detailLoading={detailLoading}
        detailError={detailError}
        closeDetail={closeDetail}
        setEditing={setEditing}
        setTitle={setTitle}
        setMarkdown={setMarkdown}
        save={save}
        removeEntry={removeEntry}
      />
    </div>
  );
}
