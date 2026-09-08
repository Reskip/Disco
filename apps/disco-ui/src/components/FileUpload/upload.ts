import { authenticatedFetch, getFreshAccessToken } from '../../utils/authenticatedFetch';

export interface UploadedFile {
  ref: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface UploadFilesToSessionOptions {
  sessionId: string;
  daemonUrl: string;
  files: File[];
  notifyAgent?: boolean;
  message?: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadFilesToSessionResult {
  success: boolean;
  files: UploadedFile[];
  warning?: string;
}

export async function uploadFilesToSession({
  sessionId,
  daemonUrl,
  files,
  notifyAgent = false,
  message = '',
  signal,
  onProgress,
}: UploadFilesToSessionOptions): Promise<UploadFilesToSessionResult> {
  const formData = new FormData();

  files.forEach(file => {
    formData.append('files', file);
  });
  formData.append('notifyAgent', String(notifyAgent));
  formData.append('message', message);

  const uploadUrl = `${daemonUrl}/sessions/${sessionId}/upload`;

  // Fetch still does not expose upload progress. XHR is deliberately scoped to
  // this transport helper so the composer can show real byte progress while
  // keeping the authenticated upload endpoint and response contract unchanged.
  if (typeof XMLHttpRequest !== 'undefined') {
    const sendWithXhr = async (attempt: 0 | 1): Promise<UploadFilesToSessionResult> => {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
      const accessToken = await getFreshAccessToken({
        daemonUrl,
        forceRefresh: attempt === 1,
      });
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

      return new Promise<UploadFilesToSessionResult>((resolve, reject) => {
        const request = new XMLHttpRequest();
        const abort = () => request.abort();
        const cleanup = () => signal?.removeEventListener('abort', abort);
        request.open('POST', uploadUrl);
        request.responseType = 'json';
        if (accessToken) request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        request.upload.addEventListener('progress', event => {
          const total = event.lengthComputable
            ? event.total
            : files.reduce((n, file) => n + file.size, 0);
          const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
          onProgress?.({ loaded: event.loaded, total, percent });
        });
        request.addEventListener('load', () => {
          cleanup();
          if (request.status === 401 && attempt === 0) {
            void sendWithXhr(1).then(resolve, reject);
            return;
          }

          const body =
            request.response ??
            (() => {
              try {
                return JSON.parse(request.responseText || '{}') as unknown;
              } catch {
                return { error: request.responseText || 'Upload failed' };
              }
            })();
          if (request.status >= 200 && request.status < 300) {
            onProgress?.({ loaded: 1, total: 1, percent: 100 });
            resolve(body as UploadFilesToSessionResult);
            return;
          }
          if (request.status === 401) {
            reject(new Error('登录状态已过期，请重新登录。'));
            return;
          }
          const error = body as { error?: string; message?: string };
          reject(new Error(error.error || error.message || `Upload failed (${request.status})`));
        });
        request.addEventListener('error', () => {
          cleanup();
          reject(new Error('上传连接中断，请重试。'));
        });
        request.addEventListener('abort', () => {
          cleanup();
          reject(new DOMException('Upload aborted', 'AbortError'));
        });
        signal?.addEventListener('abort', abort, { once: true });
        request.send(formData);
      });
    };

    return sendWithXhr(0);
  }

  const response = await authenticatedFetch(
    uploadUrl,
    {
      method: 'POST',
      body: formData,
      signal,
      // Bearer-only endpoint; do not send cookies/credentials.
    },
    { daemonUrl }
  );
  if (!response.ok) {
    const errorText = await response.text();
    let error: { error?: string } = {};
    try {
      error = JSON.parse(errorText);
    } catch {
      error = { error: errorText || 'Upload failed' };
    }
    throw new Error(error.error || 'Upload failed');
  }
  onProgress?.({ loaded: 1, total: 1, percent: 100 });
  return response.json();
}
