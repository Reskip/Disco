import type { Message, Paginated } from '@disco-live/client';
import { authenticatedFetch } from './authenticatedFetch';

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'object') {
    for (const [child, field] of Object.entries(value))
      appendQuery(params, `${key}[${child}]`, field);
  } else {
    params.append(key, String(value));
  }
}

/** Snapshot reads use HTTP compression; live Message events stay on the socket. */
export async function findConversationPage(
  daemonUrl: string,
  query: Record<string, unknown>
): Promise<Paginated<Message>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) appendQuery(params, key, value);
  const response = await authenticatedFetch(
    `${daemonUrl.replace(/\/$/, '')}/messages?${params}`,
    { cache: 'no-store' },
    { daemonUrl }
  );
  const result = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(result.message || '对话加载失败'), { code: response.status });
  }
  return result;
}
