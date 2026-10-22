import {
  ArrowLeftOutlined,
  CloseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type {
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeLibraryStatus,
  KnowledgeListOptions,
  KnowledgeListResult,
  KnowledgeOrganization,
  KnowledgeOverview,
} from '@disco/core/types';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Pagination,
  Segmented,
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
import { KnowledgeProgress } from './KnowledgeProgress';
import { knowledgeApi } from './knowledgeApi';
import {
  entryOrganization,
  errorMessage,
  formatDate,
  GENERATION_LABELS,
  hasSummaryFailure,
  INDEX_LABELS,
  LEVEL_LABELS,
  MATERIAL_LABELS,
  PARSE_LABELS,
  PROCESSING_DESCRIPTIONS,
  PROCESSING_LABELS,
  SOURCE_LABELS,
} from './knowledgePresentation';

function boundedReadingDetail(value: KnowledgeEntryDetail): KnowledgeEntryDetail {
  if (value.markdown.length <= 40_000 || value.page) return value;
  // Mutation responses contain the full saved document. Keep reading just as
  // bounded as a normal paginated request, including after an edit or review.
  const boundary = /[\uD800-\uDBFF]/u.test(value.markdown[39_999]) ? 39_999 : 40_000;
  return {
    ...value,
    markdown: value.markdown.slice(0, boundary),
    page: { offset: 0, totalChars: value.markdown.length, nextOffset: boundary, hasMore: true },
  };
}

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
  const [view, setView] = useState<'notes' | 'sources'>('notes');
  const [noteType, setNoteType] = useState<'all' | 'summary' | 'knowledge' | 'overview'>('all');
  const [material, setMaterial] = useState<'all' | 'conversation' | 'document' | 'image' | 'file'>(
    'all'
  );
  const [reviewState, setReviewState] = useState<'all' | 'draft' | 'reviewed'>('all');
  const [processing, setProcessing] = useState<'all' | keyof typeof PROCESSING_LABELS>('all');
  const [topic, setTopic] = useState('all');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [selection, setSelection] = useState<Map<string, string>>(new Map());
  const [organizeMode, setOrganizeMode] = useState<'manual' | 'automatic' | null>(null);
  const [organizeTitle, setOrganizeTitle] = useState('');
  const [organizeTopic, setOrganizeTopic] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<KnowledgeListResult | null>(null);
  const [status, setStatus] = useState<KnowledgeLibraryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(entryId || null);
  const [readingHistory, setReadingHistory] = useState<Array<{ id: string; title: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<KnowledgeEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [organization, setOrganization] = useState<KnowledgeOrganization>({
    topic: '未分类',
    level: 'knowledge',
    state: 'reviewed',
  });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const previousPageOffsetsRef = useRef(new Map<number, number>());
  const editingRef = useRef(editing);
  editingRef.current = editing || fullLoading;
  const dirty =
    editing &&
    (!detail
      ? Boolean(title || markdown)
      : title !== detail.entry.title ||
        markdown !== detail.markdown ||
        JSON.stringify(organization) !== JSON.stringify(entryOrganization(detail.entry)));

  useEffect(() => {
    setSelectedId(entryId || null);
    setCreating(false);
    setReadingHistory([]);
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
      const filters: KnowledgeListOptions = {
        ...(view === 'notes'
          ? {
              kind: 'note',
              sort: 'curated',
              ...(noteType !== 'all' ? { noteType } : {}),
              ...(reviewState !== 'all' ? { reviewState } : {}),
            }
          : {
              level: 'source',
              ...(material !== 'all' ? { materialType: material } : {}),
              includeHistory,
            }),
        ...(topic !== 'all' ? { topic } : {}),
        ...(processing !== 'all' ? { processing } : {}),
      };
      try {
        const catalog = await knowledgeApi.catalog(
          query,
          source,
          offset,
          controller.signal,
          filters
        );
        if (controller.signal.aborted) return;
        setResult({ entries: catalog.entries, total: catalog.total });
        setStatus(catalog.status);
        setOverview(catalog.overview);
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        pending = false;
      }
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
  }, [
    query,
    source,
    offset,
    revision,
    view,
    noteType,
    material,
    reviewState,
    processing,
    topic,
    includeHistory,
  ]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const requestId = ++detailRequestRef.current;
    previousPageOffsetsRef.current.clear();
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setEditing(false);
    setFullLoading(false);
    void knowledgeApi.detail(selectedId, controller.signal, { offset: 0, limit: 40_000 }).then(
      (value) => {
        if (controller.signal.aborted || requestId !== detailRequestRef.current) return;
        setDetail(value);
        setTitle(value.entry.title);
        setMarkdown(value.markdown);
        setOrganization(entryOrganization(value.entry));
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

  const generatingId =
    !editing &&
    detail &&
    (detail.entry.summaryProgress ||
      hasSummaryFailure(detail.entry) ||
      (detail.entry.generation &&
        ['queued', 'running', 'failed'].includes(detail.entry.generation.state)))
      ? detail.entry.id
      : null;
  const generatingPageOffset = detail?.page?.offset ?? 0;
  useEffect(() => {
    if (!generatingId) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || editingRef.current || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const value = await knowledgeApi.detail(generatingId, controller.signal, {
          offset: generatingPageOffset,
          limit: 40_000,
        });
        if (controller.signal.aborted || editingRef.current) return;
        setDetail(value);
        setTitle(value.entry.title);
        setMarkdown(value.markdown);
        setOrganization(entryOrganization(value.entry));
      } catch {
        /* Retain the last readable draft if the connection drops. */
      } finally {
        pending = false;
      }
    };
    const interval = window.setInterval(() => void refresh(), 5_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [generatingId, generatingPageOffset]);

  const closeDetail = useCallback(() => {
    if (saving) return;
    const close = () => {
      ++detailRequestRef.current;
      setSelectedId(null);
      setCreating(false);
      setEditing(false);
      setFullLoading(false);
      setDetail(null);
      setDetailError(null);
      setReadingHistory([]);
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

  const startEditing = async () => {
    if (!detail || fullLoading || detailLoading) return;
    const requestId = ++detailRequestRef.current;
    editingRef.current = true;
    setFullLoading(true);
    setDetailError(null);
    try {
      const complete = await knowledgeApi.detail(detail.entry.id);
      if (requestId !== detailRequestRef.current) return;
      if (complete.page?.hasMore || (complete.page?.offset ?? 0) > 0) {
        throw new Error('未能加载完整原文，暂时无法编辑。请重试或下载完整原文。');
      }
      setDetail(complete);
      setTitle(complete.entry.title);
      setMarkdown(complete.markdown);
      setOrganization(entryOrganization(complete.entry));
      setEditing(true);
    } catch (cause) {
      if (requestId === detailRequestRef.current) setDetailError(errorMessage(cause));
    } finally {
      if (requestId === detailRequestRef.current) setFullLoading(false);
    }
  };

  const loadDetailPage = async (pageOffset: number) => {
    if (!detail || detailLoading || fullLoading) return;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const value = await knowledgeApi.detail(detail.entry.id, undefined, {
        offset: pageOffset,
        limit: 40_000,
        contentHash: detail.contentHash,
      });
      if (requestId !== detailRequestRef.current) return;
      if (value.page && value.page.offset > (detail.page?.offset ?? 0)) {
        previousPageOffsetsRef.current.set(value.page.offset, detail.page?.offset ?? 0);
      }
      setDetail(value);
    } catch (cause) {
      if (requestId === detailRequestRef.current) setDetailError(errorMessage(cause));
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  };

  const save = async () => {
    if (!title.trim() || saving || (!creating && !detail)) return;
    if (detail?.page?.hasMore || (detail?.page?.offset ?? 0) > 0) {
      setDetailError('原文尚未完整加载，无法保存。请重新打开编辑。');
      return;
    }
    setSaving(true);
    setDetailError(null);
    try {
      const metadata = { ...organization, topic: organization.topic.trim() || '未分类' };
      const saved = !detail
        ? await knowledgeApi.create(title.trim(), markdown, metadata)
        : await knowledgeApi.save(
            detail!.entry.id,
            title.trim(),
            markdown,
            detail!.entry.updatedAt,
            metadata
          );
      setDetail(boundedReadingDetail(saved));
      setTitle(saved.entry.title);
      setMarkdown(saved.markdown);
      setOrganization(entryOrganization(saved.entry));
      setEditing(false);
      setRevision((value) => value + 1);
      // Keep a newly created note in this drawer without a second detail request.
      void message.success('已保存，人工修改不会被自动总结覆盖');
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
          setSelection((previous) => {
            const next = new Map(previous);
            next.delete(entry.id);
            return next;
          });
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

  const confirmReviewed = async () => {
    if (!detail || saving || detailLoading || fullLoading) return;
    setSaving(true);
    setDetailError(null);
    try {
      const complete = await knowledgeApi.detail(detail.entry.id);
      if (complete.page?.hasMore || (complete.page?.offset ?? 0) > 0) {
        throw new Error('未能加载完整原文，暂时无法确认。请重试。');
      }
      if (complete.contentHash !== detail.contentHash) {
        throw new Error('这份资料已有新修改，请重新打开并阅读最新内容后再确认。');
      }
      const saved = await knowledgeApi.save(
        complete.entry.id,
        complete.entry.title,
        complete.markdown,
        complete.entry.updatedAt,
        { ...entryOrganization(complete.entry), state: 'reviewed' }
      );
      setDetail(boundedReadingDetail(saved));
      setOrganization(entryOrganization(saved.entry));
      setRevision((value) => value + 1);
      void message.success('已确认，由你维护，自动整理不会覆盖');
    } catch (cause) {
      setDetailError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const changeView = (value: 'notes' | 'sources') => {
    setView(value);
    setOffset(0);
    setResult(null);
    if (value === 'notes' && (processing === 'parse_error' || processing === 'metadata_only')) {
      setProcessing('all');
    }
    if (
      value === 'notes' &&
      overview?.noteTopics &&
      topic !== 'all' &&
      !overview.noteTopics.some((item) => item.topic === topic)
    ) {
      setTopic('all');
    }
  };
  const hasActiveFilters = Boolean(
    query ||
      source !== 'all' ||
      topic !== 'all' ||
      processing !== 'all' ||
      (view === 'notes' ? noteType !== 'all' || reviewState !== 'all' : material !== 'all')
  );
  const clearFilters = () => {
    setSearch('');
    setQuery('');
    setSource('all');
    setTopic('all');
    setNoteType('all');
    setMaterial('all');
    setReviewState('all');
    setProcessing('all');
    setIncludeHistory(false);
    setOffset(0);
  };
  const showProcessing = (
    nextView: 'notes' | 'sources',
    nextProcessing: keyof typeof PROCESSING_LABELS
  ) => {
    clearFilters();
    setView(nextView);
    setProcessing(nextProcessing);
    setResult(null);
  };
  const openEntry = (id: string) => {
    setCreating(false);
    setReadingHistory([]);
    setSelectedId(id);
  };
  const openSource = (id: string) => {
    if (!detail || editingRef.current || saving || id === detail.entry.id) return;
    setReadingHistory((history) => [
      ...history,
      { id: detail.entry.id, title: detail.entry.title },
    ]);
    setCreating(false);
    setSelectedId(id);
  };
  const returnToPreviousEntry = () => {
    const previous = readingHistory.at(-1);
    if (!previous || editingRef.current || saving) return;
    setReadingHistory((history) => history.slice(0, -1));
    setCreating(false);
    setSelectedId(previous.id);
  };
  const startOrganizing = (mode: 'manual' | 'automatic') => {
    setOrganizeTitle('');
    setOrganizeTopic(topic === 'all' ? '' : topic);
    setOrganizeMode(mode);
  };
  const organize = async () => {
    if (!organizeMode || !selection.size || organizing) return;
    setOrganizing(true);
    try {
      const mode = organizeMode;
      const saved = await knowledgeApi.organize({
        entryIds: [...selection.keys()],
        title: organizeTitle.trim() || undefined,
        topic: organizeTopic.trim() || undefined,
        mode,
      });
      setOrganizeMode(null);
      setSelection(new Map());
      setView('notes');
      setOffset(0);
      setResult(null);
      setSource('all');
      setTopic('all');
      setNoteType('all');
      setReviewState('all');
      setProcessing('all');
      setSearch('');
      setQuery('');
      setRevision((value) => value + 1);
      if (mode === 'manual') {
        setSelectedId(null);
        setCreating(true);
        setDetailLoading(false);
        setDetailError(null);
        setDetail(saved);
        setTitle(saved.entry.title);
        setMarkdown(saved.markdown);
        // This newly created template is authored by the person editing it.
        // Confirm it only when they save; automatic drafts keep their review state.
        setOrganization({ ...entryOrganization(saved.entry), state: 'reviewed' });
        setEditing(true);
      } else {
        openEntry(saved.entry.id);
        void message.success('已加入后台整理队列，完成后可在知识笔记中审阅');
      }
    } catch (cause) {
      void message.error(errorMessage(cause));
    } finally {
      setOrganizing(false);
    }
  };
  const visibleEntries = result?.entries ?? [];
  const selectedVisibleCount = visibleEntries.filter((entry) => selection.has(entry.id)).length;
  const filterStyle = {
    minWidth: 130,
    flex: mobile ? '1 1 130px' : undefined,
    fontSize: mobile ? 16 : undefined,
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
              setOrganization({
                topic: topic === 'all' ? '未分类' : topic,
                level: 'knowledge',
                state: 'reviewed',
              });
              setEditing(true);
            }}
          >
            新建笔记
          </Button>
        </Flex>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            原始资料保留出处，摘要提取要点，专题知识沉淀结论。人工修改的笔记始终由你维护。
          </Typography.Paragraph>
          <KnowledgeImportActions
            onChanged={() => setRevision((value) => value + 1)}
            onViewSources={() => {
              clearFilters();
              changeView('sources');
            }}
          />
          {status && (
            <KnowledgeProgress
              status={status}
              mobile={mobile}
              issues={overview?.issues}
              onShowProcessing={showProcessing}
            />
          )}
          <Segmented
            block={mobile}
            aria-label="知识库视图"
            value={view}
            onChange={changeView}
            options={[
              {
                value: 'notes',
                label: `知识笔记${overview ? ` ${overview.counts.summary + overview.counts.knowledge}` : ''}`,
              },
              {
                value: 'sources',
                label: `原始资料${overview ? ` ${overview.counts.source}` : ''}`,
              },
            ]}
          />
          {view === 'notes' && (
            <Flex wrap gap={token.marginXS} role="group" aria-label="笔记分类">
              {[
                { value: 'all', label: '全部笔记' },
                { value: 'knowledge', label: '专题知识' },
                { value: 'summary', label: '摘要' },
                { value: 'overview', label: '资料概览' },
              ].map((item) => (
                <Button
                  key={item.value}
                  size="small"
                  type={noteType === item.value ? 'primary' : 'default'}
                  aria-pressed={noteType === item.value}
                  onClick={() => {
                    setNoteType(item.value as typeof noteType);
                    setOffset(0);
                  }}
                  style={{ flex: mobile ? '1 1 calc(50% - 4px)' : undefined }}
                >
                  {item.label}
                </Button>
              ))}
            </Flex>
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
              aria-label="知识主题"
              value={topic}
              onChange={(value) => {
                setTopic(value);
                setOffset(0);
              }}
              style={filterStyle}
              showSearch
              optionFilterProp="label"
              options={[
                { value: 'all', label: '全部主题' },
                ...(
                  (view === 'notes' ? overview?.noteTopics : undefined) ??
                  overview?.topics ??
                  []
                ).map((item) => ({
                  value: item.topic,
                  label: `${item.topic} (${item.count})`,
                })),
              ]}
            />
            <Select
              aria-label="资料来源"
              value={source}
              onChange={(value) => {
                setSource(value);
                setOffset(0);
              }}
              style={filterStyle}
              options={[
                { value: 'all', label: '全部来源' },
                ...Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
            {view === 'notes' ? (
              <Select
                aria-label="审阅状态"
                value={reviewState}
                onChange={(value) => {
                  setReviewState(value);
                  setOffset(0);
                }}
                style={filterStyle}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'draft', label: '待审阅' },
                  { value: 'reviewed', label: '已确认' },
                ]}
              />
            ) : (
              <Select
                aria-label="资料类型"
                value={material}
                onChange={(value) => {
                  setMaterial(value);
                  setOffset(0);
                }}
                style={filterStyle}
                options={[
                  { value: 'all', label: '全部类型' },
                  ...(['conversation', 'document', 'image', 'file'] as const).map((value) => ({
                    value,
                    label: MATERIAL_LABELS[value],
                  })),
                ]}
              />
            )}
            <Select
              aria-label="处理状态"
              value={processing}
              onChange={(value) => {
                setProcessing(value);
                setOffset(0);
              }}
              style={filterStyle}
              options={[
                { value: 'all', label: '全部处理状态' },
                ...Object.entries(PROCESSING_LABELS)
                  .filter(
                    ([value]) =>
                      view === 'sources' || value === 'index_error' || value === 'summary_error'
                  )
                  .map(([value, label]) => ({ value, label })),
              ]}
            />
          </Flex>
          {processing !== 'all' && (
            <Typography.Text type="secondary">
              {view === 'notes' && processing === 'summary_error'
                ? '打开草稿可查看失败原因与整理来源，也可以直接编辑并保存人工结论。'
                : PROCESSING_DESCRIPTIONS[processing]}
            </Typography.Text>
          )}
          {error && (
            <Alert type="warning" showIcon title={error} description="连接恢复后会自动重试。" />
          )}
          {view === 'sources' && (
            <Checkbox
              checked={includeHistory}
              onChange={(event) => {
                setIncludeHistory(event.target.checked);
                setOffset(0);
              }}
            >
              包含修复前的历史副本
            </Checkbox>
          )}
          <Card styles={{ body: { padding: `0 ${mobile ? token.padding : token.paddingLG}px` } }}>
            <Flex
              wrap
              justify="space-between"
              align="center"
              gap={token.marginSM}
              style={{ paddingBlock: token.paddingSM }}
            >
              <Space>
                <Checkbox
                  aria-label="选择本页资料"
                  disabled={!visibleEntries.length}
                  checked={
                    Boolean(visibleEntries.length) && selectedVisibleCount === visibleEntries.length
                  }
                  indeterminate={
                    selectedVisibleCount > 0 && selectedVisibleCount < visibleEntries.length
                  }
                  onChange={(event) =>
                    setSelection((previous) => {
                      const next = new Map(previous);
                      for (const entry of visibleEntries) {
                        if (event.target.checked) next.set(entry.id, entry.title);
                        else next.delete(entry.id);
                      }
                      return next;
                    })
                  }
                />
                <Typography.Text type="secondary">
                  {selection.size ? `已选 ${selection.size} 份` : `共 ${result?.total ?? 0} 份`}
                </Typography.Text>
                {!!selection.size && (
                  <Button type="link" onClick={() => setSelection(new Map())}>
                    清空选择
                  </Button>
                )}
              </Space>
              <Space wrap>
                <Button disabled={!selection.size} onClick={() => startOrganizing('manual')}>
                  人工整理
                </Button>
                <Button disabled={!selection.size} onClick={() => startOrganizing('automatic')}>
                  自动整理所选
                </Button>
              </Space>
            </Flex>
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
                        hasActiveFilters
                          ? '没有找到匹配的资料'
                          : view === 'notes'
                            ? '还没有整理笔记。可从原始资料中选择内容，人工整理或生成草稿。'
                            : '历史会话将在后台同步，也可以增加本地资料。'
                      }
                    >
                      <Space wrap>
                        {hasActiveFilters && <Button onClick={clearFilters}>清除筛选</Button>}
                        {view === 'notes' && (
                          <Button onClick={() => changeView('sources')}>查看原始资料</Button>
                        )}
                      </Space>
                    </Empty>
                  ),
                }}
                renderItem={(entry) => {
                  const metadata = entryOrganization(entry);
                  const preview = query
                    ? entry.snippet || metadata.summary
                    : metadata.summary || entry.snippet;
                  return (
                    <List.Item>
                      <Flex
                        style={{ width: '100%', minWidth: 0 }}
                        gap={token.marginSM}
                        align="flex-start"
                      >
                        <Checkbox
                          aria-label={`选择 ${entry.title}`}
                          checked={selection.has(entry.id)}
                          style={{ marginTop: token.marginXS }}
                          onChange={(event) =>
                            setSelection((previous) => {
                              const next = new Map(previous);
                              if (event.target.checked) next.set(entry.id, entry.title);
                              else next.delete(entry.id);
                              return next;
                            })
                          }
                        />
                        {!mobile && (
                          <FileTextOutlined
                            style={{ color: token.colorTextSecondary, fontSize: token.fontSizeLG }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Button
                            type="link"
                            onClick={() => openEntry(entry.id)}
                            style={{
                              padding: 0,
                              maxWidth: '100%',
                              height: 'auto',
                              whiteSpace: 'normal',
                              textAlign: 'left',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {entry.title || '未命名资料'}
                          </Button>
                          {preview && (
                            <Typography.Paragraph
                              type="secondary"
                              ellipsis={{ rows: 2 }}
                              style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}
                            >
                              {preview}
                            </Typography.Paragraph>
                          )}
                          <Flex
                            wrap
                            align="center"
                            gap={token.marginXS}
                            style={{ marginTop: token.marginXS }}
                          >
                            <Tag>{metadata.topic}</Tag>
                            <Typography.Text type="secondary">
                              {entry.kind === 'note'
                                ? metadata.level !== 'knowledge' &&
                                  entry.summaryMode === 'structured_overview'
                                  ? '资料概览'
                                  : LEVEL_LABELS[metadata.level]
                                : MATERIAL_LABELS[entry.materialType ?? entry.kind]}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {SOURCE_LABELS[entry.source]}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {formatDate(entry.updatedAt)}
                            </Typography.Text>
                            {entry.kind === 'note' && (
                              <Tag>{metadata.state === 'reviewed' ? '已确认' : '待审阅'}</Tag>
                            )}
                            {entry.humanEdited && <Tag>人工维护</Tag>}
                            {entry.historical && <Tag>历史副本</Tag>}
                            {entry.generation && entry.generation.state !== 'complete' && (
                              <Tag
                                color={
                                  entry.generation.state === 'failed' ? 'warning' : 'processing'
                                }
                              >
                                {GENERATION_LABELS[entry.generation.state]}
                              </Tag>
                            )}
                            {entry.kind !== 'note' && hasSummaryFailure(entry) && (
                              <Tag color="warning">整理失败，后台重试</Tag>
                            )}
                            <Tag color={entry.indexStatus === 'error' ? 'error' : undefined}>
                              {entry.indexStatus === 'indexed' &&
                              (entry.parseStatus === 'unsupported' || entry.parseStatus === 'error')
                                ? '仅文件信息可检索'
                                : INDEX_LABELS[entry.indexStatus]}
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
                  );
                }}
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
        organization={organization}
        topics={overview?.topics.map((item) => item.topic) ?? []}
        detail={detail}
        detailLoading={detailLoading}
        fullLoading={fullLoading}
        detailError={detailError}
        closeDetail={closeDetail}
        startEditing={startEditing}
        loadDetailPage={loadDetailPage}
        previousPageOffset={previousPageOffsetsRef.current.get(detail?.page?.offset ?? 0) ?? 0}
        setTitle={setTitle}
        setMarkdown={setMarkdown}
        setOrganization={setOrganization}
        save={save}
        confirmReviewed={confirmReviewed}
        openEntry={openSource}
        previousEntryTitle={readingHistory.at(-1)?.title}
        returnToPreviousEntry={returnToPreviousEntry}
        removeEntry={removeEntry}
      />
      <Modal
        open={Boolean(organizeMode)}
        title={organizeMode === 'manual' ? '创建人工整理笔记' : '自动整理所选资料'}
        onCancel={() => {
          if (!organizing) setOrganizeMode(null);
        }}
        onOk={() => void organize()}
        confirmLoading={organizing}
        okButtonProps={{ disabled: !selection.size || organizing }}
        okText={organizeMode === 'manual' ? '创建并编辑' : '加入整理队列'}
        cancelText="取消"
        maskClosable={!organizing}
      >
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph style={{ margin: 0 }}>
            {organizeMode === 'manual'
              ? '根据所选资料建立带来源引用的笔记，接下来由你填写要点和结论。'
              : '后台提取共识、结论和未解决事项，生成待审阅草稿。原始资料保持完整，人工维护的笔记不会被覆盖。'}
          </Typography.Paragraph>
          <Typography.Text type="secondary">已选 {selection.size} 份来源</Typography.Text>
          <List
            size="small"
            bordered
            dataSource={[...selection.entries()]}
            locale={{ emptyText: '已清空选择。关闭此窗口后，可重新选择来源。' }}
            style={{ width: '100%', maxHeight: token.controlHeight * 7, overflowY: 'auto' }}
            renderItem={([id, sourceTitle]) => (
              <List.Item>
                <Flex
                  align="center"
                  justify="space-between"
                  gap={token.marginSM}
                  style={{ width: '100%' }}
                >
                  <Typography.Text style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {sourceTitle}
                  </Typography.Text>
                  <Button
                    type="text"
                    icon={<CloseOutlined />}
                    aria-label={`移除来源 ${sourceTitle}`}
                    disabled={organizing}
                    onClick={() =>
                      setSelection((previous) => {
                        const next = new Map(previous);
                        next.delete(id);
                        return next;
                      })
                    }
                  />
                </Flex>
              </List.Item>
            )}
          />
          <Input
            aria-label="整理笔记标题"
            placeholder="笔记标题（可选）"
            value={organizeTitle}
            onChange={(event) => setOrganizeTitle(event.target.value)}
            disabled={organizing}
            style={{ fontSize: mobile ? 16 : undefined }}
          />
          <Input
            aria-label="整理笔记主题"
            placeholder="归入主题，例如产品设计（可选）"
            value={organizeTopic}
            onChange={(event) => setOrganizeTopic(event.target.value)}
            disabled={organizing}
            style={{ fontSize: mobile ? 16 : undefined }}
          />
        </Space>
      </Modal>
    </div>
  );
}
