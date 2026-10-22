import {
  ArrowLeftOutlined,
  CheckOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import type {
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeOrganization,
} from '@disco/core/types';
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Card,
  Drawer,
  Flex,
  Input,
  List,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { KnowledgeNoteContent } from './KnowledgeNoteContent';
import { knowledgeApi } from './knowledgeApi';
import {
  entryOrganization,
  errorMessage,
  formatDate,
  formatSummaryProgress,
  GENERATION_LABELS,
  hasSummaryFailure,
  LEVEL_LABELS,
  PARSE_LABELS,
  SOURCE_LABELS,
  safeSourceUrl,
} from './knowledgePresentation';

export function KnowledgeEntryDrawer({
  open,
  mobile,
  editing,
  saving,
  title,
  markdown,
  organization,
  topics,
  detail,
  detailLoading,
  fullLoading,
  detailError,
  closeDetail,
  startEditing,
  loadDetailPage,
  previousPageOffset,
  setTitle,
  setMarkdown,
  setOrganization,
  save,
  confirmReviewed,
  openEntry,
  previousEntryTitle,
  returnToPreviousEntry,
  removeEntry,
}: {
  open: boolean;
  mobile: boolean;
  editing: boolean;
  saving: boolean;
  title: string;
  markdown: string;
  organization: KnowledgeOrganization;
  topics: string[];
  detail: KnowledgeEntryDetail | null;
  detailLoading: boolean;
  fullLoading: boolean;
  detailError: string | null;
  closeDetail: () => void;
  startEditing: () => Promise<void>;
  loadDetailPage: (offset: number) => Promise<void>;
  previousPageOffset: number;
  setTitle: (value: string) => void;
  setMarkdown: (value: string) => void;
  setOrganization: (value: KnowledgeOrganization) => void;
  save: () => Promise<void>;
  confirmReviewed: () => Promise<void>;
  openEntry: (id: string) => void;
  previousEntryTitle?: string;
  returnToPreviousEntry: () => void;
  removeEntry: (entry: KnowledgeEntry) => void;
}) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadingMarkdown, setDownloadingMarkdown] = useState(false);
  const readingRef = useRef<HTMLDivElement>(null);
  const detailTopRef = useRef<HTMLDivElement>(null);
  const previousReadingRef = useRef<{ id: string; offset: number } | null>(null);
  const page = detail?.page;
  const paged = Boolean(page && (page.hasMore || page.offset > 0));
  const readingEntryId = detail?.entry.id;
  const readingOffset = detail?.page?.offset ?? 0;
  useEffect(() => {
    if (!open) {
      previousReadingRef.current = null;
      return;
    }
    if (!readingEntryId) return;
    if (previousReadingRef.current?.id !== readingEntryId) {
      detailTopRef.current?.scrollIntoView?.({ block: 'start' });
    } else if (previousReadingRef.current.offset !== readingOffset) {
      readingRef.current?.scrollIntoView?.({ block: 'start' });
    }
    previousReadingRef.current = { id: readingEntryId, offset: readingOffset };
  }, [open, readingEntryId, readingOffset]);
  const metadata = entryOrganization(detail?.entry);
  const generation = detail?.entry.generation;
  const sources = detail?.sources;
  const sourcesCard = sources?.length ? (
    <Card size="small" title="整理来源">
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {sources.map((source) =>
          source.available ? (
            <Button
              key={source.id}
              type="link"
              icon={<LinkOutlined />}
              {...(editing
                ? {
                    href: `/knowledge?entry=${encodeURIComponent(source.id)}`,
                    target: '_blank',
                    rel: 'noreferrer',
                  }
                : { onClick: () => openEntry(source.id) })}
              style={{
                paddingInline: 0,
                height: 'auto',
                maxWidth: '100%',
                whiteSpace: 'normal',
                textAlign: 'left',
                overflowWrap: 'anywhere',
              }}
            >
              {source.title}
            </Button>
          ) : (
            <Typography.Text key={source.id} type="secondary">
              {source.title}（原始归档已删除）
            </Typography.Text>
          )
        )}
        {editing && (
          <Typography.Text type="secondary">来源在新页面打开，当前编辑内容会保留。</Typography.Text>
        )}
      </Space>
    </Card>
  ) : null;
  const downloadAttachment = async (id: string, name: string) => {
    if (!detail) return;
    setDownloadingId(id);
    try {
      await knowledgeApi.downloadAttachment(detail.entry.id, id, name);
    } catch (cause) {
      void message.error(errorMessage(cause));
    } finally {
      setDownloadingId(null);
    }
  };
  const downloadMarkdown = async () => {
    if (!detail) return;
    setDownloadingMarkdown(true);
    try {
      await knowledgeApi.downloadMarkdown(detail.entry.id, detail.entry.title);
    } catch (cause) {
      void message.error(errorMessage(cause));
    } finally {
      setDownloadingMarkdown(false);
    }
  };
  return (
    <Drawer
      title={
        <span
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: mobile ? 3 : 2,
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {editing ? (!detail ? '新建笔记' : '编辑资料') : detail?.entry.title || '资料详情'}
        </span>
      }
      open={open}
      onClose={closeDetail}
      size={mobile ? '100%' : 'min(860px, 90vw)'}
      maskClosable={!saving}
      keyboard={!saving}
      destroyOnHidden
      extra={
        detail && !editing ? (
          <Button
            icon={<EditOutlined />}
            onClick={() => void startEditing()}
            loading={fullLoading}
            disabled={detailLoading || saving}
          >
            编辑
          </Button>
        ) : null
      }
      footer={
        editing ? (
          <Flex justify="flex-end" gap={token.marginSM}>
            <Button disabled={saving} onClick={closeDetail}>
              取消
            </Button>
            <Button
              type="primary"
              loading={saving}
              disabled={!title.trim()}
              onClick={() => void save()}
            >
              保存
            </Button>
          </Flex>
        ) : paged && page ? (
          <Flex align="center" justify="space-between" gap={token.marginSM} wrap>
            <Typography.Text type="secondary">
              {page.offset + 1}–{page.offset + (detail?.markdown.length ?? 0)} / {page.totalChars}{' '}
              字符
            </Typography.Text>
            <Space>
              <Button
                disabled={page.offset === 0 || detailLoading || fullLoading || saving}
                onClick={() => void loadDetailPage(previousPageOffset)}
              >
                上一段
              </Button>
              <Button
                disabled={page.nextOffset === null || detailLoading || fullLoading || saving}
                loading={detailLoading}
                onClick={() => page.nextOffset !== null && void loadDetailPage(page.nextOffset)}
              >
                下一段
              </Button>
            </Space>
          </Flex>
        ) : null
      }
    >
      <div ref={detailTopRef} />
      {!editing && previousEntryTitle && (
        <Button
          type="link"
          icon={<ArrowLeftOutlined />}
          onClick={returnToPreviousEntry}
          aria-label={`返回上一份资料：${previousEntryTitle}`}
          disabled={saving || fullLoading}
          style={{
            paddingInline: 0,
            marginBottom: token.marginSM,
            height: 'auto',
            whiteSpace: 'normal',
            textAlign: 'left',
          }}
        >
          返回：{previousEntryTitle}
        </Button>
      )}
      {detailLoading && !detail && <Skeleton active paragraph={{ rows: 10 }} />}
      {detailError && (
        <Alert type="error" title={detailError} showIcon style={{ marginBottom: token.margin }} />
      )}
      {editing ? (
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Input
            aria-label="资料标题"
            placeholder="标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={saving}
            style={{ fontSize: mobile ? 16 : undefined }}
          />
          <Typography.Text type="secondary">
            保存后标记为人工编辑，自动总结不会覆盖这份内容。
          </Typography.Text>
          {generation && ['queued', 'running'].includes(generation.state) && (
            <Alert
              type="info"
              showIcon
              title="保存人工修改后，将保留你的内容，后台生成结果不会覆盖。"
            />
          )}
          <Flex gap={token.marginSM} wrap>
            <AutoComplete
              aria-label="笔记主题"
              value={organization.topic}
              options={topics.map((value) => ({ value }))}
              onChange={(value) => setOrganization({ ...organization, topic: value })}
              filterOption={(input, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              disabled={saving}
              style={{ flex: '1 1 180px', fontSize: mobile ? 16 : undefined }}
            >
              <Input
                aria-label="笔记主题"
                placeholder="主题"
                style={{ fontSize: mobile ? 16 : undefined }}
              />
            </AutoComplete>
            {(!detail || detail.entry.kind === 'note') && (
              <>
                <Select
                  aria-label="笔记层级"
                  value={organization.level}
                  onChange={(level) => setOrganization({ ...organization, level })}
                  disabled={saving}
                  style={{ flex: '1 1 120px', fontSize: mobile ? 16 : undefined }}
                  options={[
                    { value: 'summary', label: '摘要' },
                    { value: 'knowledge', label: '专题知识' },
                  ]}
                />
                <Select
                  aria-label="笔记审阅状态"
                  value={organization.state}
                  onChange={(state) => setOrganization({ ...organization, state })}
                  disabled={saving}
                  style={{ flex: '1 1 120px', fontSize: mobile ? 16 : undefined }}
                  options={[
                    { value: 'draft', label: '待审阅' },
                    { value: 'reviewed', label: '已确认' },
                  ]}
                />
              </>
            )}
          </Flex>
          {sourcesCard}
          <Input.TextArea
            aria-label="Markdown 正文"
            placeholder="用 Markdown 记录知识、经验或结论…"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            disabled={saving}
            autoSize={{ minRows: 16, maxRows: 36 }}
            style={{ fontFamily: token.fontFamilyCode, fontSize: mobile ? 16 : undefined }}
          />
        </Space>
      ) : (
        detail && (
          <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
            <Card size="small">
              <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                <Space wrap>
                  <Tag>{metadata.topic}</Tag>
                  <Tag>
                    {metadata.level !== 'knowledge' &&
                    detail.entry.summaryMode === 'structured_overview'
                      ? '资料概览'
                      : LEVEL_LABELS[metadata.level]}
                  </Tag>
                  {detail.entry.kind === 'note' && (
                    <Tag>{metadata.state === 'reviewed' ? '已确认' : '待审阅'}</Tag>
                  )}
                </Space>
                <Typography.Text type="secondary">
                  来源：{SOURCE_LABELS[detail.entry.source]} · {formatDate(detail.entry.createdAt)}
                </Typography.Text>
                <Typography.Text type="secondary" copyable style={{ overflowWrap: 'anywhere' }}>
                  {detail.entry.relativePath}
                </Typography.Text>
                {detail.entry.humanEdited && (
                  <Typography.Text>已由人工编辑，自动总结不会覆盖。</Typography.Text>
                )}
                {safeSourceUrl(detail.entry.sourceUrl) && (
                  <Button
                    type="link"
                    icon={<LinkOutlined />}
                    href={safeSourceUrl(detail.entry.sourceUrl)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ paddingInline: 0 }}
                  >
                    查看原始出处
                  </Button>
                )}
              </Space>
            </Card>
            {generation && generation.state !== 'complete' && (
              <Alert
                type={generation.state === 'failed' ? 'warning' : 'info'}
                showIcon
                title={GENERATION_LABELS[generation.state]}
                description={
                  (generation.state !== 'failed'
                    ? formatSummaryProgress(generation.progress)
                    : undefined) ||
                  generation.message ||
                  (generation.retryAt
                    ? `下次重试 ${formatDate(generation.retryAt)}`
                    : '无需保持页面打开，后台会继续处理。')
                }
              />
            )}
            {!generation && detail.entry.summaryProgress && (
              <Alert
                type="info"
                showIcon
                title="知识整理进度"
                description={formatSummaryProgress(detail.entry.summaryProgress)}
              />
            )}
            {detail.entry.kind !== 'note' && hasSummaryFailure(detail.entry) && (
              <Alert
                type="warning"
                showIcon
                title="自动整理尚未成功，原文已保留"
                description={
                  <Space orientation="vertical">
                    <Typography.Text>{detail.entry.summaryMessage}</Typography.Text>
                    {detail.entry.summaryRetryAt && (
                      <Typography.Text>
                        下次重试 {formatDate(detail.entry.summaryRetryAt)}
                      </Typography.Text>
                    )}
                  </Space>
                }
              />
            )}
            {detail.entry.indexStatus === 'error' && (
              <Alert
                type="warning"
                showIcon
                title="检索索引尚未构建成功"
                description={
                  <Space orientation="vertical">
                    <Typography.Text>
                      {detail.entry.indexMessage || '后台将自动重试，原始内容仍可读取。'}
                    </Typography.Text>
                    {detail.entry.indexRetryAt && (
                      <Typography.Text>
                        下次重试 {formatDate(detail.entry.indexRetryAt)}
                      </Typography.Text>
                    )}
                  </Space>
                }
              />
            )}
            {detail.entry.kind === 'note' &&
              metadata.state === 'draft' &&
              (!generation || generation.state === 'complete') && (
                <Button
                  icon={<CheckOutlined />}
                  onClick={() => void confirmReviewed()}
                  loading={saving}
                  disabled={detailLoading || fullLoading}
                >
                  确认并人工维护
                </Button>
              )}
            {sourcesCard}
            {detail.entry.summaryDisposition === 'archive_only' && (
              <Typography.Text type="secondary">
                仅保留原始归档：
                {detail.entry.summaryReason || '这份资料暂无可复用的知识，仍可阅读和检索。'}
              </Typography.Text>
            )}
            {detail.entry.parseStatus && detail.entry.parseStatus !== 'parsed' && (
              <Alert
                type={detail.entry.parseStatus === 'pending' ? 'info' : 'warning'}
                showIcon
                title={PARSE_LABELS[detail.entry.parseStatus]}
                description={detail.entry.parseMessage}
              />
            )}
            <Flex align="center" gap={token.marginSM} wrap>
              <Button
                icon={<DownloadOutlined />}
                loading={downloadingMarkdown}
                onClick={() => void downloadMarkdown()}
              >
                下载 Markdown 归档
              </Button>
              {paged && (
                <Typography.Text type="secondary">长文按段阅读，完整归档不受影响。</Typography.Text>
              )}
            </Flex>
            <div ref={readingRef}>
              {detail.entry.kind === 'note' && !paged ? (
                <KnowledgeNoteContent markdown={detail.markdown} />
              ) : (
                <Typography.Paragraph
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}
                >
                  {detail.markdown || '（正文为空）'}
                </Typography.Paragraph>
              )}
            </div>
            {!!detail.entry.attachments?.length && (
              <Card size="small" title="关联附件">
                <List
                  dataSource={detail.entry.attachments}
                  renderItem={(attachment) => (
                    <List.Item>
                      {attachment.id ? (
                        <Button
                          type="link"
                          icon={<DownloadOutlined />}
                          loading={downloadingId === attachment.id}
                          onClick={() => void downloadAttachment(attachment.id!, attachment.name)}
                          style={{
                            whiteSpace: 'normal',
                            height: 'auto',
                            maxWidth: '100%',
                            textAlign: 'left',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {attachment.name}
                        </Button>
                      ) : safeSourceUrl(attachment.sourceUrl) ? (
                        <Button
                          type="link"
                          href={safeSourceUrl(attachment.sourceUrl)}
                          target="_blank"
                          rel="noreferrer"
                          icon={<LinkOutlined />}
                          style={{
                            whiteSpace: 'normal',
                            height: 'auto',
                            maxWidth: '100%',
                            textAlign: 'left',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {attachment.name}
                        </Button>
                      ) : (
                        <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                          {attachment.name}
                        </Typography.Text>
                      )}
                    </List.Item>
                  )}
                />
              </Card>
            )}
            <Button danger icon={<DeleteOutlined />} onClick={() => removeEntry(detail.entry)}>
              删除知识库记录
            </Button>
          </Space>
        )
      )}
    </Drawer>
  );
}
