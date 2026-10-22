import { DeleteOutlined, DownloadOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import type { KnowledgeEntry, KnowledgeEntryDetail } from '@disco/core/types';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Drawer,
  Flex,
  Input,
  List,
  Skeleton,
  Space,
  Typography,
  theme,
} from 'antd';
import { useState } from 'react';
import { knowledgeApi } from './knowledgeApi';
import {
  errorMessage,
  formatDate,
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
  detail,
  detailLoading,
  detailError,
  closeDetail,
  setEditing,
  setTitle,
  setMarkdown,
  save,
  removeEntry,
}: {
  open: boolean;
  mobile: boolean;
  editing: boolean;
  saving: boolean;
  title: string;
  markdown: string;
  detail: KnowledgeEntryDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  closeDetail: () => void;
  setEditing: (value: boolean) => void;
  setTitle: (value: string) => void;
  setMarkdown: (value: string) => void;
  save: () => Promise<void>;
  removeEntry: (entry: KnowledgeEntry) => void;
}) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
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
  return (
    <Drawer
      title={editing ? (!detail ? '新建笔记' : '编辑资料') : detail?.entry.title || '资料详情'}
      open={open}
      onClose={closeDetail}
      size={mobile ? '100%' : 'min(860px, 90vw)'}
      maskClosable={!saving}
      keyboard={!saving}
      destroyOnHidden
      extra={
        detail && !editing ? (
          <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
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
        ) : null
      }
    >
      {detailLoading && <Skeleton active paragraph={{ rows: 10 }} />}
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
            {detail.entry.parseStatus && detail.entry.parseStatus !== 'parsed' && (
              <Alert
                type={detail.entry.parseStatus === 'pending' ? 'info' : 'warning'}
                showIcon
                title={PARSE_LABELS[detail.entry.parseStatus]}
                description={detail.entry.parseMessage}
              />
            )}
            {/* Plain text keeps imported HTML inert and never requests embedded images or files. */}
            <Typography.Paragraph
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}
            >
              {detail.markdown || '（正文为空）'}
            </Typography.Paragraph>
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
                          style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'left' }}
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
                          style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'left' }}
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
