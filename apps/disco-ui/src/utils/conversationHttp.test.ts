import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from './authenticatedFetch';
import { findConversationPage } from './conversationHttp';

vi.mock('./authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));
const fetch = vi.mocked(authenticatedFetch);
beforeEach(() => fetch.mockReset());

describe('conversation snapshot HTTP reads', () => {
  it('preserves cursor, projection and ordering parameters through authenticated HTTP', async () => {
    const page = { data: [], total: 0, skip: 0, limit: 1000 };
    fetch.mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    expect(
      await findConversationPage('https://disco.example/', {
        session_id: 'session',
        view: 'conversation',
        message_id: { $gt: 'a', $lte: 'z' },
        $sort: { message_id: 1 },
        $select: ['message_id'],
        $limit: 1000,
      })
    ).toEqual(page);
    const [url, init, options] = fetch.mock.calls[0];
    const params = new URL(String(url)).searchParams;
    expect(params.get('message_id[$gt]')).toBe('a');
    expect(params.get('message_id[$lte]')).toBe('z');
    expect(params.get('$sort[message_id]')).toBe('1');
    expect(params.get('$select[0]')).toBe('message_id');
    expect(params.get('view')).toBe('conversation');
    expect(init?.cache).toBe('no-store');
    expect(options).toEqual({ daemonUrl: 'https://disco.example/' });
  });

  it('retains status codes for the existing error and auth recovery paths', async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 })
    );
    await expect(
      findConversationPage('https://disco.example', { view: 'conversation' })
    ).rejects.toMatchObject({ code: 503, message: 'unavailable' });
  });
});
