import type { RequestHandler } from 'express';

export const VISUALIZATION_FRAME_PATH = '/visualization-frame.html';

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

export const VISUALIZATION_FRAME_CSP = [
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

export const VISUALIZATION_FRAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Disco visualization frame</title>
</head>
<body>
<script>
(() => {
  const id = decodeURIComponent(location.hash.slice(1));
  let accepted = false;
  const receive = (event) => {
    const payload = event.data;
    if (
      accepted ||
      event.source !== parent ||
      payload == null ||
      payload.type !== 'disco:visualization-document' ||
      payload.id !== id ||
      typeof payload.html !== 'string' ||
      payload.html.length > 10 * 1024 * 1024
    ) {
      return;
    }
    accepted = true;
    removeEventListener('message', receive);
    document.open();
    document.write(payload.html);
    document.close();
  };
  addEventListener('message', receive);
  parent.postMessage({ type: 'disco:visualization-ready', id }, '*');
})();
</script>
</body>
</html>`;

/**
 * Serve an empty, sandbox-targeted document with a visualization-specific CSP.
 * The authenticated UI posts the already-fetched HTML fragment into this frame;
 * no attachment data or bearer token is exposed by this unauthenticated route.
 */
export const serveVisualizationFrame: RequestHandler = (_req, res) => {
  res.setHeader('Content-Security-Policy', VISUALIZATION_FRAME_CSP);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(VISUALIZATION_FRAME_HTML);
};
