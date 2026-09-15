import { FileImageOutlined } from '@ant-design/icons';
import {
  inferPublishedFileMimeType,
  isToolImageContentBlock,
  isUploadRef,
  type ToolImageContentBlock,
} from '@disco/core/types';
import { Spin } from 'antd';
import type React from 'react';
import { AuthenticatedImage } from '../../AuthenticatedImage';
import type { ToolRendererProps } from './index';

function legacyPreviewFromInput(input: Record<string, unknown>): ToolImageContentBlock | undefined {
  if (typeof input.path !== 'string') return undefined;
  const normalized = input.path.replaceAll('\\', '/');
  const filename = normalized.split('/').at(-1)?.trim() || '图片';
  const staged = normalized.match(/\/\.disco\/session-staging\/[^/]+\/(upl_[^/]+)\/.+$/u);
  const uploadRef = staged?.[1] && isUploadRef(staged[1]) ? staged[1] : undefined;
  return {
    type: 'image',
    filename,
    mime_type: inferPublishedFileMimeType(filename),
    available: Boolean(uploadRef),
    ...(uploadRef ? { upload_ref: uploadRef } : {}),
    ...(!uploadRef ? { unavailable_reason: '历史图片预览不可用' } : {}),
  };
}

function PublishedImagePreview({ image }: { image: ToolImageContentBlock }) {
  return (
    <div className="disco-tool-image-preview-item">
      <AuthenticatedImage
        uploadRef={image.upload_ref!}
        filename={image.filename}
        className="disco-tool-image-preview-image"
      />
    </div>
  );
}

export const ViewImageRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const image =
    (Array.isArray(result?.content) ? result.content.find(isToolImageContentBlock) : undefined) ??
    legacyPreviewFromInput(input);

  if (!result && !image) {
    return (
      <div
        className="disco-tool-image-preview-state is-inline"
        role="status"
        aria-label="正在准备图片预览"
      >
        <Spin size="small" />
        <span>正在准备图片预览…</span>
      </div>
    );
  }

  if (!image?.available || !image.upload_ref) {
    return (
      <div className="disco-tool-image-preview-state is-inline is-unavailable">
        <FileImageOutlined aria-hidden />
        <span>{image?.unavailable_reason || '图片预览不可用'}</span>
      </div>
    );
  }

  return (
    <div className="disco-tool-image-preview">
      <PublishedImagePreview image={image} />
    </div>
  );
};
