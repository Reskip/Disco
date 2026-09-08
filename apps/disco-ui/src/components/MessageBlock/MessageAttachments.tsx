import {
  AudioOutlined,
  DownloadOutlined,
  FileOutlined,
  FilePdfOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  type FileCitationContentBlock,
  formatFileCitationLocator,
  formatUploadBytes,
  inferPublishedFileMimeType,
  isUploadRef,
  parseCodexFileCitations,
  replaceCodexFileCitations,
} from '@disco/core/types';
import type { ParsedUploadPromptAttachment } from '@disco-live/client';
import { parseUploadAttachmentPrompt } from '@disco-live/client';
import { Flex, Image, Spin, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { useAuthenticatedUpload } from '../../hooks/useAuthenticatedUpload';
import { useIsolatedImagePreview } from '../../hooks/useIsolatedImagePreview';
import { VisualizationCitation } from './VisualizationCitation';

export interface MessageAttachment extends Omit<ParsedUploadPromptAttachment, 'ref'> {
  uploadRef: string;
}

export interface ParsedMessageAttachments {
  attachments: MessageAttachment[];
  visibleText: string;
}

/**
 * Strip Disco's executor-only attachment preamble from the visible user text
 * while preserving the opaque refs needed for authenticated previews.
 */
export function parseMessageAttachments(content: string): ParsedMessageAttachments {
  const parsed = parseUploadAttachmentPrompt(content);
  return {
    attachments: parsed.attachments.map(({ ref, ...attachment }) => ({
      ...attachment,
      uploadRef: ref,
    })),
    visibleText: parsed.visibleText,
  };
}

export const MessageAttachmentItem: React.FC<{ attachment: MessageAttachment }> = ({
  attachment,
}) => {
  const { objectUrl, loading, unavailable } = useAuthenticatedUpload(attachment.uploadRef);
  const imagePreview = useIsolatedImagePreview();
  const mimeType = attachment.mimeType.toLowerCase();
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isAudio = mimeType.startsWith('audio/');
  const isVideo = mimeType.startsWith('video/');

  const download = () => {
    if (!objectUrl) return;
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = attachment.filename;
    anchor.click();
  };

  if (isImage) {
    return (
      <div className="disco-message-image-attachment">
        {loading ? (
          <div className="disco-message-attachment-loading">
            <Spin size="small" />
          </div>
        ) : objectUrl ? (
          <>
            <Image
              src={objectUrl}
              alt={attachment.filename}
              preview={imagePreview}
              className="disco-message-attachment-image"
            />
            <button
              type="button"
              className="disco-message-image-download"
              aria-label={`下载 ${attachment.filename}`}
              title={`下载 ${attachment.filename}`}
              onClick={download}
            >
              <DownloadOutlined aria-hidden />
            </button>
          </>
        ) : (
          <div className="disco-message-attachment-unavailable">图片已不可用</div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="disco-message-media-attachment is-loading"
        aria-label={`正在加载 ${attachment.filename}`}
      >
        <Spin size="small" />
        <span>{attachment.filename}</span>
      </div>
    );
  }

  if (!objectUrl || unavailable) {
    return (
      <div
        className="disco-message-media-attachment is-unavailable"
        aria-label={`${attachment.filename} 已不可用`}
      >
        <FileOutlined aria-hidden />
        <span>{attachment.filename}</span>
        <small>文件已不可用</small>
      </div>
    );
  }

  if (isVideo) {
    return (
      <figure className="disco-message-video-attachment">
        <video
          src={objectUrl}
          controls
          preload="metadata"
          aria-label={`播放 ${attachment.filename}`}
        />
        <figcaption>
          <VideoCameraOutlined aria-hidden />
          <span title={attachment.filename}>{attachment.filename}</span>
          {attachment.sizeLabel && <small>{attachment.sizeLabel}</small>}
          <button type="button" aria-label={`下载 ${attachment.filename}`} onClick={download}>
            <DownloadOutlined aria-hidden />
          </button>
        </figcaption>
      </figure>
    );
  }

  if (isAudio) {
    return (
      <div className="disco-message-audio-attachment">
        <div className="disco-message-media-heading">
          <AudioOutlined aria-hidden />
          <span title={attachment.filename}>{attachment.filename}</span>
          {attachment.sizeLabel && <small>{attachment.sizeLabel}</small>}
          <button type="button" aria-label={`下载 ${attachment.filename}`} onClick={download}>
            <DownloadOutlined aria-hidden />
          </button>
        </div>
        <audio
          src={objectUrl}
          controls
          preload="metadata"
          aria-label={`播放 ${attachment.filename}`}
        />
      </div>
    );
  }

  if (isPdf) {
    return (
      <div className="disco-message-document-attachment is-pdf">
        <FilePdfOutlined aria-hidden />
        <button
          type="button"
          className="disco-message-document-open"
          aria-label={`打开 ${attachment.filename}`}
          onClick={() => window.open(objectUrl, '_blank', 'noopener,noreferrer')}
        >
          <span title={attachment.filename}>{attachment.filename}</span>
          <small>{attachment.sizeLabel ? `PDF · ${attachment.sizeLabel}` : 'PDF'}</small>
        </button>
        <button type="button" aria-label={`下载 ${attachment.filename}`} onClick={download}>
          <DownloadOutlined aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="disco-message-file-attachment"
      aria-label={unavailable ? `${attachment.filename} 已不可用` : `下载 ${attachment.filename}`}
      disabled={!objectUrl}
      onClick={download}
    >
      <FileOutlined aria-hidden />
      <Typography.Text ellipsis>{attachment.filename}</Typography.Text>
      {attachment.sizeLabel && <small>{attachment.sizeLabel}</small>}
      <DownloadOutlined aria-hidden />
    </button>
  );
};

export interface ParsedLegacyFileCitations {
  citations: FileCitationContentBlock[];
  visibleText: string;
  segments: Array<{ type: 'text'; text: string } | FileCitationContentBlock>;
}

function appendLegacyText(
  segments: Array<{ type: 'text'; text: string } | FileCitationContentBlock>,
  text: string
): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else segments.push({ type: 'text', text });
}

/**
 * Historical assistant rows predate the structured content block. Recover a
 * staged upload ref from their completed Codex directive without trusting or
 * exposing the absolute path; the authenticated content endpoint remains the
 * ownership boundary.
 */
export function parseLegacyFileCitations(content: string): ParsedLegacyFileCitations {
  const parsed = parseCodexFileCitations(content);
  const citations = parsed.map((citation): FileCitationContentBlock => {
    const normalized = citation.path.replaceAll('\\', '/');
    const match = normalized.match(/\/\.disco\/session-staging\/[^/]+\/(upl_[^/]+)\/(.+)$/u);
    const filename = match?.[2]?.split('/').at(-1) || normalized.split('/').at(-1) || '文件';
    const uploadRef = match?.[1] && isUploadRef(match[1]) ? match[1] : undefined;
    return {
      type: 'file_citation',
      filename,
      purpose: citation.purpose,
      ...(Object.keys(citation.locator).length ? { locator: citation.locator } : {}),
      ...(citation.presentation ? { presentation: citation.presentation } : {}),
      ...(uploadRef ? { upload_ref: uploadRef } : {}),
      mime_type: inferPublishedFileMimeType(filename),
      available: Boolean(uploadRef),
      ...(!uploadRef ? { unavailable_reason: '历史文件未发布' } : {}),
    };
  });
  const byRaw = new Map(parsed.map((citation, index) => [citation.raw, citations[index]]));
  const segments: Array<{ type: 'text'; text: string } | FileCitationContentBlock> = [];
  let cursor = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const citation = parsed[index]!;
    appendLegacyText(segments, content.slice(cursor, citation.start));
    segments.push(citations[index]!);
    cursor = citation.end;
  }
  appendLegacyText(segments, content.slice(cursor));
  if (parsed.length === 0) {
    segments.splice(0, segments.length);
    const sanitized = replaceCodexFileCitations(content, () => '');
    appendLegacyText(segments, sanitized);
  }
  return {
    citations,
    visibleText: replaceCodexFileCitations(content, (citation) => {
      const block = byRaw.get(citation.raw);
      const locator = formatFileCitationLocator(block?.locator);
      const displayName = block?.presentation?.title || block?.filename || '文件';
      return `${displayName}${locator && locator !== displayName ? `（${locator}）` : ''}`;
    }),
    segments,
  };
}

function FileCitationItem({ citation }: { citation: FileCitationContentBlock }) {
  const { token } = theme.useToken();
  if (citation.presentation?.type === 'visualization') {
    return (
      <div className="disco-message-file-citation is-visualization">
        <VisualizationCitation citation={citation} />
      </div>
    );
  }
  const locator = formatFileCitationLocator(citation.locator);
  const metadata = (
    <Flex
      className="disco-message-file-citation-meta"
      align="center"
      gap={token.marginXXS}
      wrap
      style={{ paddingInline: token.paddingXXS }}
    >
      <span className={`disco-message-file-citation-kind is-${citation.purpose}`}>
        {citation.purpose === 'output' ? '输出文件' : '引用文件'}
      </span>
      {locator && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {locator}
        </Typography.Text>
      )}
    </Flex>
  );

  if (!citation.available || !citation.upload_ref) {
    return (
      <Flex className="disco-message-file-citation" vertical gap={token.marginXXS}>
        <div
          className="disco-message-media-attachment is-unavailable"
          aria-label={`${citation.filename} 已不可用`}
        >
          {citation.mime_type === 'application/pdf' ? <FilePdfOutlined /> : <FileOutlined />}
          <span title={citation.filename}>{citation.filename}</span>
          <small>{citation.unavailable_reason || '文件已不可用'}</small>
        </div>
        {metadata}
      </Flex>
    );
  }

  return (
    <Flex className="disco-message-file-citation" vertical gap={token.marginXXS}>
      <MessageAttachmentItem
        attachment={{
          uploadRef: citation.upload_ref,
          filename: citation.filename,
          mimeType: citation.mime_type || inferPublishedFileMimeType(citation.filename),
          sizeLabel:
            typeof citation.size === 'number' && citation.size >= 0
              ? formatUploadBytes(citation.size)
              : '',
        }}
      />
      {metadata}
    </Flex>
  );
}

export const MessageFileCitations: React.FC<{ citations: FileCitationContentBlock[] }> = ({
  citations,
}) => {
  const { token } = theme.useToken();
  if (citations.length === 0) return null;
  return (
    <Flex vertical gap={token.marginSM} style={{ marginBlock: token.marginXS }}>
      {citations.map((citation, index) => (
        <FileCitationItem
          key={`${citation.upload_ref ?? citation.filename}:${citation.purpose}:${index}`}
          citation={citation}
        />
      ))}
    </Flex>
  );
};

export const MessageAttachments: React.FC<{ attachments: MessageAttachment[] }> = ({
  attachments,
}) => {
  const images = useMemo(
    () =>
      attachments.filter((attachment) => attachment.mimeType.toLowerCase().startsWith('image/')),
    [attachments]
  );
  const files = useMemo(
    () =>
      attachments.filter((attachment) => !attachment.mimeType.toLowerCase().startsWith('image/')),
    [attachments]
  );

  if (attachments.length === 0) return null;
  return (
    <div className="disco-message-attachments">
      {images.length > 0 && (
        <div className="disco-message-image-grid">
          {images.map((attachment) => (
            <MessageAttachmentItem key={attachment.uploadRef} attachment={attachment} />
          ))}
        </div>
      )}
      {files.map((attachment) => (
        <MessageAttachmentItem key={attachment.uploadRef} attachment={attachment} />
      ))}
    </div>
  );
};
