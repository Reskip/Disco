import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetchMock, getFreshAccessTokenMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
  getFreshAccessTokenMock: vi.fn(),
}));

vi.mock('../../utils/authenticatedFetch', () => ({
  authenticatedFetch: authenticatedFetchMock,
  getFreshAccessToken: getFreshAccessTokenMock,
}));

import { uploadFilesToSession } from './upload';

type FakeResponse = { status: number; response: unknown };

class FakeXMLHttpRequest {
  static responses: FakeResponse[] = [];
  static instances: FakeXMLHttpRequest[] = [];

  status = 0;
  response: unknown = null;
  responseText = '';
  responseType = '';
  headers = new Map<string, string>();
  upload = { addEventListener: vi.fn() };
  private listeners = new Map<string, Array<() => void>>();

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open() {}

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  send() {
    const next = FakeXMLHttpRequest.responses.shift();
    if (!next) throw new Error('Missing fake XHR response');
    this.status = next.status;
    this.response = next.response;
    queueMicrotask(() => this.emit('load'));
  }

  abort() {
    this.emit('abort');
  }

  private emit(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

beforeEach(() => {
  authenticatedFetchMock.mockReset();
  getFreshAccessTokenMock.mockReset();
  FakeXMLHttpRequest.responses = [];
  FakeXMLHttpRequest.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uploadFilesToSession authentication recovery', () => {
  it('refreshes and retries the XHR upload once after a 401', async () => {
    getFreshAccessTokenMock.mockResolvedValueOnce('old-access').mockResolvedValueOnce('new-access');
    FakeXMLHttpRequest.responses = [
      { status: 401, response: { error: 'jwt expired' } },
      { status: 200, response: { success: true, files: [] } },
    ];

    const result = await uploadFilesToSession({
      sessionId: 'session-1',
      daemonUrl: 'https://disco.test',
      files: [new File(['hello'], 'hello.txt')],
    });

    expect(result).toEqual({ success: true, files: [] });
    expect(FakeXMLHttpRequest.instances).toHaveLength(2);
    expect(FakeXMLHttpRequest.instances[0].headers.get('Authorization')).toBe('Bearer old-access');
    expect(FakeXMLHttpRequest.instances[1].headers.get('Authorization')).toBe('Bearer new-access');
    expect(getFreshAccessTokenMock).toHaveBeenNthCalledWith(1, {
      daemonUrl: 'https://disco.test',
      forceRefresh: false,
    });
    expect(getFreshAccessTokenMock).toHaveBeenNthCalledWith(2, {
      daemonUrl: 'https://disco.test',
      forceRefresh: true,
    });
  });

  it('shows a localized session-expired error if the retried upload is also unauthorized', async () => {
    getFreshAccessTokenMock.mockResolvedValueOnce('old-access').mockResolvedValueOnce('new-access');
    FakeXMLHttpRequest.responses = [
      { status: 401, response: { error: 'jwt expired' } },
      { status: 401, response: { error: 'jwt expired' } },
    ];

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://disco.test',
        files: [new File(['hello'], 'hello.txt')],
      })
    ).rejects.toThrow('登录状态已过期，请重新登录。');
  });
});
