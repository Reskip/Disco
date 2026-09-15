import { FileImageOutlined } from '@ant-design/icons';
import { Button, Flex, Image, Spin, Typography, theme } from 'antd';
import { useRef } from 'react';
import { useAuthenticatedUpload } from '../hooks/useAuthenticatedUpload';
import { useInViewportOnce } from '../hooks/useInViewportOnce';
import { useIsolatedImagePreview } from '../hooks/useIsolatedImagePreview';

/** Every conversation image uses a derivative; opening its preview opts into the original. */
interface AuthenticatedImageProps {
  uploadRef: string;
  filename: string;
  className?: string;
}

export function AuthenticatedImage(props: AuthenticatedImageProps) {
  return <ThumbnailImage key={props.uploadRef} {...props} />;
}

function ThumbnailImage({ uploadRef, filename, className }: AuthenticatedImageProps) {
  const { token } = theme.useToken();
  const target = useRef<HTMLSpanElement>(null);
  const visible = useInViewportOnce(target, '0px');
  const preview = useIsolatedImagePreview();
  const thumbnail = useAuthenticatedUpload(uploadRef, { variant: 'thumbnail', enabled: visible });
  const original = useAuthenticatedUpload(uploadRef, { enabled: Boolean(preview.open) });

  const open = () => preview.onOpenChange?.(true);
  const placeholder = (
    <Button
      type="text"
      icon={thumbnail.loading ? <Spin size="small" /> : <FileImageOutlined />}
      onClick={open}
      aria-label={`查看原图 ${filename}`}
      style={{ minHeight: token.controlHeightLG * 3, maxWidth: '100%', whiteSpace: 'normal' }}
    >
      {thumbnail.unavailable ? '预览图不可用，点击查看原图' : filename}
    </Button>
  );

  return (
    <span
      ref={target}
      style={{ display: 'inline-block', maxWidth: '100%', width: '100%', height: '100%' }}
    >
      {!thumbnail.objectUrl && placeholder}
      <Image
        src={thumbnail.objectUrl ?? undefined}
        alt={filename}
        tabIndex={thumbnail.objectUrl ? 0 : -1}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        }}
        className={className}
        style={thumbnail.objectUrl ? { cursor: 'zoom-in' } : { display: 'none' }}
        styles={{ root: thumbnail.objectUrl ? { maxWidth: '100%' } : { display: 'none' } }}
        preview={{
          ...preview,
          src: original.objectUrl ?? thumbnail.objectUrl ?? undefined,
          imageRender: (image) =>
            original.unavailable ? (
              <Flex vertical align="center" gap="small">
                <Typography.Text>原图加载失败</Typography.Text>
                <Button onClick={() => void original.load().catch(() => {})}>重试</Button>
              </Flex>
            ) : original.objectUrl ? (
              image
            ) : (
              <Spin tip="正在加载原图" size="large">
                <span>{thumbnail.objectUrl ? image : null}</span>
              </Spin>
            ),
        }}
      />
    </span>
  );
}
