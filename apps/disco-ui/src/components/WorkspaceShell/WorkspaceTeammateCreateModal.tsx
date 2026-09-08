import { DeleteOutlined, SmileOutlined, UploadOutlined } from '@ant-design/icons';
import { Avatar, Button, Form, Input, Modal, Tooltip, Typography, Upload } from 'antd';
import { useEffect, useState } from 'react';
import { getDiscoPortalContainer } from '@/utils/portalContainer';
import { cropAvatarImage } from '../../utils/avatarImage';
import { COMMON_AGENT_EMOJIS } from './agentEmojis';
import './WorkspaceTeammateCreateModal.css';

export interface WorkspaceTeammateCreateInput {
  displayName: string;
  description?: string;
  emoji?: string;
  avatarUrl?: string;
}

interface FormValues {
  displayName: string;
  description?: string;
}

export interface WorkspaceTeammateCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: WorkspaceTeammateCreateInput) => Promise<void>;
}

export const WorkspaceTeammateCreateModal: React.FC<WorkspaceTeammateCreateModalProps> = ({
  open,
  onClose,
  onCreate,
}) => {
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState('🤖');
  const [avatarUrl, setAvatarUrl] = useState<string>();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string>();
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setSelectedEmoji('🤖');
    setAvatarUrl(undefined);
    setAvatarError(undefined);
    setUploadingAvatar(false);
    setEmojiPickerOpen(false);
    setSubmitting(false);
  }, [form, open]);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onCreate({
        displayName: values.displayName.trim(),
        description: values.description?.trim() || undefined,
        emoji: avatarUrl ? undefined : selectedEmoji,
        avatarUrl,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal
        getContainer={getDiscoPortalContainer}
        title="新建智能体"
        open={open}
        centered
        width={540}
        okText="创建并开始对话"
        cancelText="取消"
        confirmLoading={submitting}
        onCancel={submitting ? undefined : onClose}
        onOk={() => void submit()}
        destroyOnHidden
        className="disco-agent-create-modal"
        styles={{ body: { overflow: 'hidden' } }}
      >
        <Form<FormValues> form={form} layout="vertical" requiredMark={false}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            智能体会保留自己的职责说明和连续会话记忆。底层工作区由 Disco 自动管理，无需选择项目。
          </Typography.Paragraph>
          <Form.Item
            name="displayName"
            label="智能体名称"
            rules={[{ required: true, whitespace: true, message: '请输入智能体名称' }]}
          >
            <Input placeholder="例如：代码助手" autoComplete="off" />
          </Form.Item>
          <div className="disco-agent-avatar-editor">
            <div className="disco-agent-avatar-preview">
              <Avatar size={72} src={avatarUrl} className="disco-agent-avatar-circle">
                {!avatarUrl && selectedEmoji}
              </Avatar>
              <div>
                <Typography.Text strong>头像</Typography.Text>
                <Typography.Text type="secondary" className="disco-agent-avatar-caption">
                  选择常用 Emoji，或上传自己的图片
                </Typography.Text>
              </div>
            </div>
            <div className="disco-agent-avatar-actions">
              <Button icon={<SmileOutlined />} onClick={() => setEmojiPickerOpen(true)}>
                选择 Emoji
              </Button>
              <Upload
                accept="image/*"
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploadingAvatar(true);
                  setAvatarError(undefined);
                  void cropAvatarImage(file)
                    .then(setAvatarUrl)
                    .catch((error) =>
                      setAvatarError(error instanceof Error ? error.message : '头像处理失败')
                    )
                    .finally(() => setUploadingAvatar(false));
                  return Upload.LIST_IGNORE;
                }}
              >
                <Button icon={<UploadOutlined />} loading={uploadingAvatar}>
                  上传图片
                </Button>
              </Upload>
              {avatarUrl && (
                <Button
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setAvatarUrl(undefined);
                    setAvatarError(undefined);
                  }}
                >
                  改用 Emoji
                </Button>
              )}
              <Typography.Text type={avatarError ? 'danger' : 'secondary'}>
                {avatarError || '图片会自动居中裁剪为圆形头像'}
              </Typography.Text>
            </div>
          </div>
          <Form.Item name="description" label="职责说明（可选）">
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder="例如：熟悉这个项目的结构，优先维护测试，并记住长期约定。"
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        getContainer={getDiscoPortalContainer}
        title="选择智能体头像"
        open={open && emojiPickerOpen}
        centered
        width={430}
        footer={null}
        onCancel={() => setEmojiPickerOpen(false)}
        destroyOnHidden
        className="disco-agent-emoji-modal"
      >
        <ul className="disco-agent-emoji-grid" aria-label="选择智能体头像">
          {COMMON_AGENT_EMOJIS.map((emoji) => (
            <li key={emoji}>
              <Tooltip title={`使用 ${emoji}`} mouseEnterDelay={0.2}>
                <button
                  type="button"
                  aria-label={`使用 ${emoji} 作为头像`}
                  aria-pressed={!avatarUrl && selectedEmoji === emoji}
                  className={`disco-agent-emoji-option${
                    !avatarUrl && selectedEmoji === emoji ? ' is-selected' : ''
                  }`}
                  onClick={() => {
                    setSelectedEmoji(emoji);
                    setAvatarUrl(undefined);
                    setAvatarError(undefined);
                    setEmojiPickerOpen(false);
                  }}
                >
                  {emoji}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
};
