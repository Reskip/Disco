import type { KnowledgeLibraryStatus } from '@disco/core/types';
import { Alert, Card, Flex, Progress, Space, Typography, theme } from 'antd';
import { formatDate } from './knowledgePresentation';

export function KnowledgeProgress({ status }: { status: KnowledgeLibraryStatus }) {
  const { token } = theme.useToken();
  const index = status.processing?.index;
  const summary = status.processing?.summary;
  const indexed = index?.indexed ?? Math.max(0, status.total - status.pendingIndex);
  const indexTotal = indexed + (index?.pending ?? status.pendingIndex) + (index?.failed ?? 0);
  const summaryTotal = (summary?.completed ?? 0) + (summary?.pending ?? 0) + (summary?.failed ?? 0);
  return (
    <Card size="small" title="后台处理">
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Flex gap={token.marginLG} wrap>
          <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 240px' }}>
            <Typography.Text strong>原始归档 · {status.total} 份已保留</Typography.Text>
            <Typography.Text type={status.sync?.state === 'error' ? 'danger' : 'secondary'}>
              {status.sync?.message || '会话和附件自动同步到本地资料库'}
            </Typography.Text>
            <Typography.Text type="secondary">
              {status.sync?.lastCompletedAt
                ? `最近同步 ${formatDate(status.sync.lastCompletedAt)}`
                : '正在准备首次同步'}
              {status.sync?.intervalSeconds
                ? ` · 每 ${status.sync.intervalSeconds} 秒检查变更`
                : ''}
            </Typography.Text>
          </Space>
          <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 220px' }}>
            <Typography.Text strong>
              检索索引 · {indexed} / {indexTotal}
            </Typography.Text>
            <Progress
              percent={indexTotal ? Math.round((indexed / indexTotal) * 100) : 0}
              showInfo={false}
              status={index?.failed ? 'exception' : undefined}
              aria-label="检索索引进度"
            />
            <Typography.Text type={index?.failed ? 'warning' : 'secondary'}>
              待处理 {index?.pending ?? status.pendingIndex}
              {index?.failed ? ` · ${index.failed} 份失败，后台重试` : ''}
              {index?.unsupported ? ` · ${index.unsupported} 份仅保留原件` : ''}
            </Typography.Text>
            {(index?.message || index?.active) && (
              <Typography.Text type="secondary">
                {index.message || `正在索引：${index.active}`}
              </Typography.Text>
            )}
          </Space>
          <Space orientation="vertical" size={token.marginXS} style={{ flex: '1 1 220px' }}>
            <Typography.Text strong>
              知识整理 · {summary?.completed ?? status.notes} 篇已生成
            </Typography.Text>
            <Progress
              percent={
                summaryTotal ? Math.round(((summary?.completed ?? 0) / summaryTotal) * 100) : 0
              }
              showInfo={false}
              status={summary?.failed ? 'exception' : undefined}
              aria-label="知识整理进度"
            />
            <Typography.Text type={summary?.failed ? 'warning' : 'secondary'}>
              待整理 {summary?.pending ?? 0}
              {summary?.failed ? ` · ${summary.failed} 份失败，后台重试` : ''}
            </Typography.Text>
            <Typography.Text type="secondary">
              {summary?.message ||
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
    </Card>
  );
}
