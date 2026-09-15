import { DownloadOutlined, ExpandOutlined } from '@ant-design/icons';
import type { FileCitationContentBlock } from '@disco/core/types';
import { Button, Modal, Spin, theme } from 'antd';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useOptionalTheme } from '../../contexts/ThemeContext';
import { useAuthenticatedUpload } from '../../hooks/useAuthenticatedUpload';
import { useThemedMessage } from '../../utils/message';
import { isDarkTheme } from '../../utils/theme';
import visualizeCss from './visualization-runtime/visualize.css?raw';
import visualizeKit from './visualization-runtime/visualize.html?raw';

const VISUALIZATION_PLACEHOLDER = '<!--__INLINE_VISUALIZATION_FRAGMENT__-->';
const VISUALIZATION_RESOURCE_SOURCES = [
  'blob:',
  'data:',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://esm.sh',
  'https://fonts.bunny.net',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://unpkg.com',
].join(' ');
const VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${VISUALIZATION_RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${VISUALIZATION_RESOURCE_SOURCES}`,
  `img-src ${VISUALIZATION_RESOURCE_SOURCES}`,
  `font-src ${VISUALIZATION_RESOURCE_SOURCES}`,
  `media-src ${VISUALIZATION_RESOURCE_SOURCES}`,
  'worker-src blob:',
  'connect-src blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('读取交互图失败')), {
      once: true,
    });
    reader.readAsText(blob, 'utf-8');
  });
}

export function buildVisualizationDocument(input: {
  fragment: string;
  title: string;
  dark: boolean;
  channelId: string;
}): string {
  const body = visualizeKit.replace(VISUALIZATION_PLACEHOLDER, input.fragment);
  const resizeScript = `<script>(()=>{const id=${JSON.stringify(input.channelId)};const report=()=>parent.postMessage({type:'disco:visualization-size',id,height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0))},'*');new ResizeObserver(report).observe(document.documentElement);addEventListener('load',report);report()})()</script>`;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${input.dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}">
<title>${escapeHtml(input.title)}</title>
<style>${visualizeCss}
html>body{padding:0;overflow-x:hidden}</style>
</head>
<body>${body}${resizeScript}</body>
</html>`;
}

export interface VisualizationCitationProps {
  citation: FileCitationContentBlock;
}

function postVisualizationDocument(
  frame: HTMLIFrameElement | null,
  id: string,
  document: string | null
): void {
  if (!frame?.contentWindow || !document) return;
  frame.contentWindow.postMessage(
    { type: 'disco:visualization-document', id, html: document },
    '*'
  );
}

export const VisualizationCitation: React.FC<VisualizationCitationProps> = ({ citation }) => {
  const { token } = theme.useToken();
  const themeContext = useOptionalTheme();
  const dark = themeContext?.isDark ?? isDarkTheme(token);
  const channelId = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const expandedFrameRef = useRef<HTMLIFrameElement>(null);
  const [fragment, setFragment] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [requested, setRequested] = useState(false);
  const { showError } = useThemedMessage();
  const [frameHeight, setFrameHeight] = useState(
    citation.presentation?.mode === 'wide' ? 500 : 420
  );
  const { blob, loading, unavailable, load } = useAuthenticatedUpload(citation.upload_ref ?? '');
  const title = citation.presentation?.title || citation.locator?.label || citation.filename;
  const channelVersion = `${citation.upload_ref ?? citation.filename}:${dark ? 'dark' : 'light'}`;
  const inlineChannelId = `${channelId}:inline:${channelVersion}`;
  const expandedChannelId = `${channelId}:expanded:${channelVersion}`;
  const visualizationFrameBaseUrl = `${getDaemonUrl().replace(/\/$/, '')}/visualization-frame.html`;

  useEffect(() => {
    let active = true;
    setFragment(null);
    setLoadError(false);
    if (!blob || !requested) return () => undefined;
    void readBlobText(blob)
      .then((value) => {
        if (active) setFragment(value);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [blob, requested]);

  const document = useMemo(
    () =>
      fragment === null
        ? null
        : buildVisualizationDocument({ fragment, title, dark, channelId: inlineChannelId }),
    [dark, fragment, inlineChannelId, title]
  );
  const expandedDocument = useMemo(
    () =>
      fragment === null
        ? null
        : buildVisualizationDocument({ fragment, title, dark, channelId: expandedChannelId }),
    [dark, expandedChannelId, fragment, title]
  );

  useEffect(() => {
    const receiveSize = (event: MessageEvent) => {
      const payload = event.data as { type?: unknown; id?: unknown; height?: unknown } | null;
      if (
        payload?.type === 'disco:visualization-ready' &&
        payload.id === inlineChannelId &&
        event.source === frameRef.current?.contentWindow
      ) {
        postVisualizationDocument(frameRef.current, inlineChannelId, document);
        return;
      }
      if (
        payload?.type === 'disco:visualization-ready' &&
        payload.id === expandedChannelId &&
        event.source === expandedFrameRef.current?.contentWindow
      ) {
        postVisualizationDocument(expandedFrameRef.current, expandedChannelId, expandedDocument);
        return;
      }
      if (event.source !== frameRef.current?.contentWindow) return;
      if (
        payload?.type !== 'disco:visualization-size' ||
        payload.id !== inlineChannelId ||
        typeof payload.height !== 'number' ||
        !Number.isFinite(payload.height)
      ) {
        return;
      }
      setFrameHeight(Math.max(280, Math.min(720, payload.height)));
    };
    window.addEventListener('message', receiveSize);
    return () => window.removeEventListener('message', receiveSize);
  }, [document, expandedChannelId, expandedDocument, inlineChannelId]);

  const download = async () => {
    try {
      const upload = await load();
      const anchor = window.document.createElement('a');
      anchor.href = upload.objectUrl;
      anchor.download = citation.filename;
      anchor.click();
    } catch {
      showError('文件加载失败，请重试');
    }
  };

  const openVisualization = () => {
    setRequested(true);
    void load().catch(() => {});
  };

  const failed = unavailable || loadError || !citation.available;
  return (
    <section className="disco-message-visualization" aria-label={`交互图 ${title}`}>
      <header className="disco-message-visualization-header">
        <div className="disco-message-visualization-heading">
          <span className="disco-message-visualization-kind">交互图</span>
          <span className="disco-message-visualization-title" title={title}>
            {title}
          </span>
        </div>
        <div className="disco-message-visualization-actions">
          <button
            type="button"
            aria-label={`放大查看 ${title}`}
            title="放大查看"
            disabled={!document}
            onClick={() => setExpanded(true)}
          >
            <ExpandOutlined aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`下载 ${citation.filename}`}
            title="下载"
            disabled={loading || !citation.available}
            onClick={() => void download()}
          >
            <DownloadOutlined aria-hidden />
          </button>
        </div>
      </header>
      <div
        className="disco-message-visualization-body"
        style={{ height: requested ? frameHeight : 100 }}
      >
        {!citation.available ? (
          <div className="disco-message-visualization-state is-unavailable">
            {citation.unavailable_reason || '交互图已不可用'}
          </div>
        ) : !requested ? (
          <div className="disco-message-visualization-state">
            <Button onClick={openVisualization} disabled={!citation.available}>
              加载交互图
            </Button>
          </div>
        ) : loading || (!failed && !document) ? (
          <div className="disco-message-visualization-state">
            <Spin size="small" />
            <span>正在加载交互图</span>
          </div>
        ) : failed ? (
          <div className="disco-message-visualization-state is-unavailable">
            {citation.unavailable_reason || '交互图已不可用'}
            {citation.available && <Button onClick={openVisualization}>重试</Button>}
          </div>
        ) : (
          <iframe
            ref={frameRef}
            src={`${visualizationFrameBaseUrl}#${encodeURIComponent(inlineChannelId)}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={title}
            onLoad={() => postVisualizationDocument(frameRef.current, inlineChannelId, document)}
          />
        )}
      </div>
      <Modal
        className="disco-visualization-modal"
        open={expanded}
        title={title}
        footer={null}
        width="min(1120px, calc(100vw - 32px))"
        destroyOnHidden
        onCancel={() => setExpanded(false)}
      >
        {document && (
          <iframe
            ref={expandedFrameRef}
            className="disco-message-visualization-expanded-frame"
            src={`${visualizationFrameBaseUrl}#${encodeURIComponent(expandedChannelId)}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={`${title} 大图`}
            onLoad={() =>
              postVisualizationDocument(
                expandedFrameRef.current,
                expandedChannelId,
                expandedDocument
              )
            }
          />
        )}
      </Modal>
    </section>
  );
};
