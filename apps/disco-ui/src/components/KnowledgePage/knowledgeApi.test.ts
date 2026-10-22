import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/authenticatedFetch';
import { knowledgeApi } from './knowledgeApi';

vi.mock('../../config/daemon', () => ({ getDaemonUrl: () => 'https://disco.example' }));
vi.mock('../../utils/authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));

describe('knowledge HTTP client', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('uploads the chosen original file as multipart without forcing a JSON content type', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    const file = new File(['原始内容'], '资料.md', { type: 'text/markdown' });
    await knowledgeApi.uploadDocument(file);
    const [url, options] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(url).toBe('https://disco.example/knowledge/documents');
    expect(options?.method).toBe('POST');
    expect(options?.body).toBeInstanceOf(FormData);
    const form = options?.body;
    if (!(form instanceof FormData)) throw new Error('Expected multipart upload');
    expect(form.get('file')).toBe(file);
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false);
    expect(form.has('userId')).toBe(false);
  });

  it('reports a stale edit as a conflict instead of silently retrying an overwrite', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 409 }));
    await expect(knowledgeApi.save('entry-a', '标题', '人工修改', 'old-version')).rejects.toThrow(
      '已有新修改'
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(JSON.parse(options?.body as string)).toEqual({
      title: '标题',
      markdown: '人工修改',
      expectedUpdatedAt: 'old-version',
    });
  });

  it('preserves source filtering and pagination without fetching document bodies', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response('{"entries":[],"total":0}', { status: 200 })
    );
    await knowledgeApi.list('中文 记录', 'codex', 20);
    const url = new URL(vi.mocked(authenticatedFetch).mock.calls[0][0] as string);
    expect(url.pathname).toBe('/knowledge/entries');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '中文 记录',
      source: 'codex',
      offset: '20',
      limit: '20',
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('loads the list, overview and processing status through one catalog request', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    await knowledgeApi.catalog('资料', 'manual', 20, undefined, {
      materialType: 'image',
      level: 'source',
    });
    const url = new URL(vi.mocked(authenticatedFetch).mock.calls[0][0] as string);
    expect(url.pathname).toBe('/knowledge/catalog');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '资料',
      source: 'manual',
      offset: '20',
      limit: '20',
      materialType: 'image',
      level: 'source',
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('pins subsequent reading segments to their content version and leaves edit reads complete', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    await knowledgeApi.detail('entry-a', undefined, {
      offset: 40_000,
      limit: 40_000,
      contentHash: 'version-a',
    });
    await knowledgeApi.detail('entry-a');
    const first = new URL(vi.mocked(authenticatedFetch).mock.calls[0][0] as string);
    expect(Object.fromEntries(first.searchParams)).toEqual({
      offset: '40000',
      limit: '40000',
      contentHash: 'version-a',
    });
    expect(vi.mocked(authenticatedFetch).mock.calls[1][0]).toBe(
      'https://disco.example/knowledge/entries/entry-a'
    );
  });

  it('streams a full authenticated export to the chosen file without buffering a blob', async () => {
    const chunks: Uint8Array[] = [];
    const closed = vi.fn();
    const destination = new WritableStream<Uint8Array>({
      write: (chunk) => {
        chunks.push(chunk);
      },
      close: closed,
    });
    const picker = vi.fn().mockResolvedValue({ createWritable: async () => destination });
    vi.stubGlobal('showSaveFilePicker', picker);
    const response = new Response('complete archive bytes');
    const blob = vi.spyOn(response, 'blob');
    vi.mocked(authenticatedFetch).mockResolvedValue(response);
    await knowledgeApi.exportLibrary();
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: '知识库.zip' }));
    expect(authenticatedFetch).toHaveBeenCalledWith('https://disco.example/knowledge/export');
    expect(new TextDecoder().decode(chunks[0])).toBe('complete archive bytes');
    expect(closed).toHaveBeenCalledOnce();
    expect(blob).not.toHaveBeenCalled();
  });

  it('sends organization filters and explicit selected source IDs without an owner override', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    await knowledgeApi.list('轨道', 'all', 40, undefined, {
      level: 'source',
      materialType: 'document',
      topic: '铁路',
      includeHistory: true,
    });
    const url = new URL(vi.mocked(authenticatedFetch).mock.calls[0][0] as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '轨道',
      offset: '40',
      limit: '20',
      level: 'source',
      materialType: 'document',
      topic: '铁路',
      includeHistory: 'true',
    });
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    await knowledgeApi.organize({ entryIds: ['a', 'b'], mode: 'automatic', topic: '铁路' });
    const [requestUrl, init] = vi.mocked(authenticatedFetch).mock.calls[1];
    expect(requestUrl).toBe('https://disco.example/knowledge/organize');
    expect(JSON.parse(init?.body as string)).toEqual({
      entryIds: ['a', 'b'],
      mode: 'automatic',
      topic: '铁路',
    });
  });

  it('does not request an export when the save dialog is cancelled', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    );
    await expect(knowledgeApi.exportLibrary()).resolves.toBeUndefined();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('aborts the file write when the authenticated export fails', async () => {
    const aborted = vi.fn();
    const destination = new WritableStream<Uint8Array>({ abort: aborted });
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn().mockResolvedValue({ createWritable: async () => destination })
    );
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(knowledgeApi.exportLibrary()).rejects.toThrow('下载失败（403）');
    expect(aborted).toHaveBeenCalledOnce();
  });
});
