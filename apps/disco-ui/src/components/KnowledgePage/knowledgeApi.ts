import type {
  KnowledgeCatalogResult,
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeLibraryStatus,
  KnowledgeListOptions,
  KnowledgeListResult,
  KnowledgeOverview,
  KnowledgeUploadResult,
} from '@disco/core/types';
import { getDaemonUrl } from '../../config/daemon';
import { authenticatedFetch } from '../../utils/authenticatedFetch';

type ArchiveSavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(
    `${getDaemonUrl().replace(/\/$/u, '')}/knowledge${path}`,
    {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    }
  );
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(
        init?.method === 'PATCH'
          ? '这份资料已有新修改。请先保存好当前草稿，重新打开资料后再合并修改。'
          : '这份资料已有新修改，请重新打开后继续阅读。'
      );
    }
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.message === 'string' ? body.message : `知识库请求失败（${response.status}）`
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function download(path: string, fallbackName: string): Promise<void> {
  const response = await authenticatedFetch(
    `${getDaemonUrl().replace(/\/$/u, '')}/knowledge${path}`
  );
  if (!response.ok) throw new Error(`下载失败（${response.status}），请稍后重试。`);
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  let filename = /filename="([^"]+)"/iu.exec(disposition)?.[1] || fallbackName;
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded);
    } catch {
      /* Keep the ordinary filename. */
    }
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.replace(/[\\/]/gu, '_');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportLibrary(): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: ArchiveSavePicker }).showSaveFilePicker;
  if (!picker) return download('/export', '知识库.zip');

  // Request the destination during the click gesture. Stream authenticated ZIP
  // bytes directly to disk rather than retaining the whole library in memory.
  let handle: Awaited<ReturnType<ArchiveSavePicker>>;
  try {
    handle = await picker.call(window, {
      suggestedName: '知识库.zip',
      types: [{ description: '知识库 ZIP 归档', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  }
  const destination = await handle.createWritable();
  try {
    const response = await authenticatedFetch(
      `${getDaemonUrl().replace(/\/$/u, '')}/knowledge/export`
    );
    if (!response.ok) throw new Error(`下载失败（${response.status}），请稍后重试。`);
    if (!response.body) throw new Error('下载内容为空，请稍后重试。');
    await response.body.pipeTo(destination);
  } catch (error) {
    await destination.abort().catch(() => undefined);
    throw error;
  }
}

type CatalogFilters = Pick<
  KnowledgeListOptions,
  | 'kind'
  | 'materialType'
  | 'level'
  | 'topic'
  | 'reviewState'
  | 'includeHistory'
  | 'noteType'
  | 'sort'
>;

function listParams(query: string, source: string, offset: number, filters?: CatalogFilters) {
  const params = new URLSearchParams({ query, offset: String(offset), limit: '20' });
  if (source !== 'all') params.set('source', source);
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value) params.set(key, String(value));
  }
  return params;
}

export const knowledgeApi = {
  status: (signal?: AbortSignal) => request<KnowledgeLibraryStatus>('/status', { signal }),
  overview: (signal?: AbortSignal) => request<KnowledgeOverview>('/overview', { signal }),
  list: (
    query: string,
    source: string,
    offset: number,
    signal?: AbortSignal,
    filters?: CatalogFilters
  ) =>
    request<KnowledgeListResult>(`/entries?${listParams(query, source, offset, filters)}`, {
      signal,
    }),
  catalog: (
    query: string,
    source: string,
    offset: number,
    signal?: AbortSignal,
    filters?: CatalogFilters
  ) =>
    request<KnowledgeCatalogResult>(`/catalog?${listParams(query, source, offset, filters)}`, {
      signal,
    }),
  detail: (
    id: string,
    signal?: AbortSignal,
    page?: { offset: number; limit: number; contentHash?: string }
  ) => {
    const params = page
      ? new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) })
      : null;
    if (page?.contentHash) params?.set('contentHash', page.contentHash);
    return request<KnowledgeEntryDetail>(
      `/entries/${encodeURIComponent(id)}${params ? `?${params}` : ''}`,
      { signal }
    );
  },
  create: (title: string, markdown: string, organization?: KnowledgeEntry['organization']) =>
    request<KnowledgeEntryDetail>('/entries', {
      method: 'POST',
      body: JSON.stringify({ title, markdown, organization }),
    }),
  save: (
    id: string,
    title: string,
    markdown: string,
    expectedUpdatedAt: string,
    organization?: KnowledgeEntry['organization']
  ) =>
    request<KnowledgeEntryDetail>(`/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, markdown, expectedUpdatedAt, organization }),
    }),
  organize: (input: {
    entryIds: string[];
    title?: string;
    topic?: string;
    mode: 'manual' | 'automatic';
  }) =>
    request<KnowledgeEntryDetail>('/organize', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  remove: (id: string) => request<void>(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadDocument: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<KnowledgeUploadResult>('/documents', { method: 'POST', body });
  },
  exportLibrary,
  downloadMarkdown: (entryId: string, title: string) =>
    download(`/entries/${encodeURIComponent(entryId)}/markdown`, `${title}.md`),
  downloadAttachment: (entryId: string, attachmentId: string, name: string) =>
    download(
      `/entries/${encodeURIComponent(entryId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      name
    ),
};
