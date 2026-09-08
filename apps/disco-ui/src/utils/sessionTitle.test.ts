import type { Session } from '@disco-live/client';
import { describe, expect, it } from 'vitest';
import { getSessionDisplayTitle } from './sessionTitle';

describe('getSessionDisplayTitle', () => {
  it('uses a Chinese fallback before the first prompt generates a title', () => {
    const session = {
      session_id: '01a031a9-9d7d-7167-8387-1c4db1cf4312',
      agentic_tool: 'codex',
    } as Session;

    expect(getSessionDisplayTitle(session)).toBe('未命名对话');
  });
});
