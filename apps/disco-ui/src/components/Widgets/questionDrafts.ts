import type { QuestionsResult } from '@disco-live/client';
import { createStore } from 'zustand/vanilla';
import { getDaemonUrl } from '../../config/daemon';
import { getCurrentTenantIdFromJwt, getCurrentUserIdFromJwt } from '../../utils/authHeaders';
import { TOKENS_CHANGED_EVENT } from '../../utils/tokenRefresh';

interface QuestionDraft extends QuestionsResult {
  submitting: boolean;
  resolved: 'submitted' | 'dismissed' | null;
  error: string | null;
}

function ownerKey(): string {
  return JSON.stringify([getDaemonUrl(), getCurrentTenantIdFromJwt(), getCurrentUserIdFromJwt()]);
}

const drafts = new Map<
  string,
  {
    owner: string;
    sessionId: string;
    store: ReturnType<typeof createDraft>;
  }
>();

function createDraft() {
  return createStore<QuestionDraft>(() => ({
    answers: {},
    submitting: false,
    resolved: null,
    error: null,
  }));
}

export function getQuestionDraft(sessionId: string, widgetId: string) {
  const owner = ownerKey();
  const key = JSON.stringify([owner, sessionId, widgetId]);
  let draft = drafts.get(key);
  if (!draft) {
    draft = { owner, sessionId, store: createDraft() };
    drafts.set(key, draft);
  }
  return draft.store;
}

export function clearQuestionDrafts(sessionId?: string): void {
  for (const [key, draft] of drafts) {
    if (!sessionId || draft.sessionId === sessionId) drafts.delete(key);
  }
}

function clearOtherAccounts() {
  const owner = ownerKey();
  for (const [key, draft] of drafts) {
    if (!getCurrentUserIdFromJwt() || draft.owner !== owner) drafts.delete(key);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(TOKENS_CHANGED_EVENT, clearOtherAccounts);
  window.addEventListener('storage', clearOtherAccounts);
}
