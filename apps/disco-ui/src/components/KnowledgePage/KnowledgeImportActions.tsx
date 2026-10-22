import { CloseOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Flex, Typography, Upload } from 'antd';
import { useState } from 'react';
import { knowledgeApi } from './knowledgeApi';
import { errorMessage } from './knowledgePresentation';

export function KnowledgeImportActions({
  onChanged,
  onViewSources,
}: {
  onChanged: () => void;
  onViewSources: () => void;
}) {
  const { message } = AntApp.useApp();
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsingNotices, setParsingNotices] = useState<string[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  const upload = async (files: File[]) => {
    setUploading(true);
    setError(null);
    setParsingNotices([]);
    setImportedCount(0);
    // Start all selected requests while this account is active. Navigating away
    // does not abort already-started uploads or their server-side ingestion.
    const outcomes = await Promise.allSettled(
      files.map((file) => knowledgeApi.uploadDocument(file))
    );
    const failed = outcomes.flatMap((result, index) =>
      result.status === 'rejected' ? [`${files[index].name}：${errorMessage(result.reason)}`] : []
    );
    const imported = files.length - failed.length;
    setImportedCount(imported);
    setParsingNotices(
      outcomes.flatMap((result, index) => {
        if (result.status !== 'fulfilled') return [];
        const parsing = result.value.parsing;
        if (!parsing || parsing.status === 'parsed') return [];
        const fallback = {
          unsupported: '暂不支持解析此格式，正文尚不能检索。',
          error: '正文解析失败，原件仍可下载。',
          protected: '已保留人工修改的正文。',
        }[parsing.status];
        return [`${files[index].name}：${parsing.message || fallback}`];
      })
    );
    if (imported) {
      void message.success(`已保存 ${imported} 份原件`);
      onChanged();
    }
    if (failed.length) setError(failed.join('\n'));
    setUploading(false);
  };
  const exportLibrary = async () => {
    setExporting(true);
    setError(null);
    try {
      await knowledgeApi.exportLibrary();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <Flex wrap align="center" gap="small">
        <Upload
          multiple
          showUploadList={false}
          disabled={uploading}
          beforeUpload={(file, files) => {
            if (file.uid === files[0]?.uid) void upload(files);
            return Upload.LIST_IGNORE;
          }}
        >
          <Button icon={<UploadOutlined />} loading={uploading}>
            增加本地资料
          </Button>
        </Upload>
        <Button
          icon={<DownloadOutlined />}
          loading={exporting}
          onClick={() => void exportLibrary()}
        >
          导出完整资料库
        </Button>
        <Typography.Text type="secondary">原文件保留，后台建立索引。</Typography.Text>
      </Flex>
      {importedCount > 0 && (
        <Alert
          type={parsingNotices.length > 0 ? 'warning' : 'success'}
          showIcon
          closable={{
            'aria-label': '关闭导入提示',
            closeIcon: <CloseOutlined />,
            onClose: () => {
              setImportedCount(0);
              setParsingNotices([]);
            },
          }}
          title={
            <Flex align="center" gap="small" wrap>
              <span>
                {parsingNotices.length > 0
                  ? '原件已保留，请留意正文解析状态'
                  : `已导入 ${importedCount} 份原件`}
              </span>
              <Button
                type="link"
                size="small"
                style={{ paddingInline: 0 }}
                onClick={() => {
                  onViewSources();
                  setImportedCount(0);
                  setParsingNotices([]);
                }}
              >
                查看原始资料
              </Button>
            </Flex>
          }
          description={
            parsingNotices.length > 0 ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>{parsingNotices.join('\n')}</span>
            ) : undefined
          }
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          closable={{
            'aria-label': '关闭操作提示',
            closeIcon: <CloseOutlined />,
            onClose: () => setError(null),
          }}
          title="部分操作未完成"
          description={<span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>}
        />
      )}
    </>
  );
}
