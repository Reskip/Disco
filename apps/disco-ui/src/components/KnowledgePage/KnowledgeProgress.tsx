import type { KnowledgeLibraryStatus } from '@disco/core/types';
import { Alert, Card, Collapse, Flex, Progress, Space, Typography, theme } from 'antd';
import { formatDate, formatSummaryProgress } from './knowledgePresentation';

function completionPercent(completed: number, total: number): number {
  if (!total) return 0;
  return completed === total ? 100 : Math.min(99, Math.round((completed / total) * 100));
}

export function KnowledgeProgress({
  status,
  mobile = false,
}: {
  status: KnowledgeLibraryStatus;
  mobile?: boolean;
}) {
  const { token } = theme.useToken();
  const index = status.processing?.index;
  const summary = status.processing?.summary;
  const indexed = index?.indexed ?? Math.max(0, status.total - status.pendingIndex);
  const indexTotal = indexed + (index?.pending ?? status.pendingIndex) + (index?.failed ?? 0);
  const summaryTotal = (summary?.completed ?? 0) + (summary?.pending ?? 0) + (summary?.failed ?? 0);
  const content = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Flex gap={token.marginLG} wrap>
        <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 240px' }}>
          <Typography.Text strong>
            原始归档 · {status.conversations + status.documents} 份已保留
          </Typography.Text>
          <Typography.Text type={status.sync?.state === 'error' ? 'danger' : 'secondary'}>
            {status.sync?.message || '会话和附件自动同步到本地资料库'}
          </Typography.Text>
          <Typography.Text type="secondary">
            {status.sync?.lastCompletedAt
              ? `最近同步 ${formatDate(status.sync.lastCompletedAt)}`
              : '正在准备首次同步'}
            {status.sync?.intervalSeconds
              ? ` · 每轮完成后 ${status.sync.intervalSeconds} 秒再次检查`
              : ''}
          </Typography.Text>
        </Space>
        <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 220px' }}>
          <Typography.Text strong>
            检索索引 · {indexed} / {indexTotal}
          </Typography.Text>
          <Progress
            percent={completionPercent(indexed, indexTotal)}
            showInfo={false}
            status={index?.failed ? 'exception' : undefined}
            aria-label="检索索引进度"
          />
          <Typography.Text type={index?.failed ? 'warning' : 'secondary'}>
            待处理 {index?.pending ?? status.pendingIndex}
            {index?.failed ? ` · ${index.failed} 份失败，后台重试` : ''}
            {index?.unsupported ? ` · 其中 ${index.unsupported} 份仅文件信息` : ''}
          </Typography.Text>
          {(index?.message || index?.active) && (
            <Typography.Text type="secondary">
              {index.message || `正在索引：${index.active}`}
            </Typography.Text>
          )}
        </Space>
        <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 220px' }}>
          <Typography.Text strong>
            知识整理 · {summary?.completed ?? status.notes} 份已处理
          </Typography.Text>
          <Progress
            percent={completionPercent(summary?.completed ?? 0, summaryTotal)}
            showInfo={false}
            status={summary?.failed ? 'exception' : undefined}
            aria-label="知识整理进度"
          />
          <Typography.Text type={summary?.failed ? 'warning' : 'secondary'}>
            笔记 {status.notes} 篇 · 待整理 {summary?.pending ?? 0}
            {summary?.archivedOnly ? ` · ${summary.archivedOnly} 份仅归档` : ''}
            {summary?.failed ? ` · ${summary.failed} 份失败，后台重试` : ''}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>
            {summary?.progress
              ? `${summary.active ? `${summary.active} · ` : ''}${formatSummaryProgress(summary.progress)}`
              : summary?.message ||
                (summary?.active ? `正在整理：${summary.active}` : '自动生成草稿，确认后由你维护')}
          </Typography.Text>
        </Space>
      </Flex>
      {status.engine && status.engine.status !== 'ready' && (
        <Alert
          type="warning"
          showIcon
          title={status.engine.message || '语义检索暂不可用，原始资料和关键词查找仍可使用。'}
        />
      )}
    </Space>
  );
  const failed = (index?.failed ?? 0) + (summary?.failed ?? 0);
  const engineUnavailable = status.engine && status.engine.status !== 'ready';
  return mobile ? (
    <Collapse
      size="small"
      items={[
        {
          key: 'processing',
          label: (
            <Space orientation="vertical" size={0}>
              <Typography.Text strong>后台处理</Typography.Text>
              <Typography.Text
                type={
                  failed || status.sync?.state === 'error' || engineUnavailable
                    ? 'warning'
                    : 'secondary'
                }
              >
                索引 {indexed}/{indexTotal} · 笔记 {status.notes} 篇
                {failed
                  ? ` · ${failed} 项异常`
                  : status.sync?.state === 'error'
                    ? ' · 同步异常'
                    : engineUnavailable
                      ? ' · 检索未就绪'
                      : ''}
              </Typography.Text>
            </Space>
          ),
          children: content,
        },
      ]}
    />
  ) : (
    <Card size="small" title="后台处理">
      {content}
    </Card>
  );
}
