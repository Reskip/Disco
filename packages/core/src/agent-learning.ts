import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AGENT_LEARNING_PATH = '.disco/learning.json';
export const AGENT_MEMORY_REVIEW_UPDATES = 8;
export const AGENT_MEMORY_REVIEW_CHARACTERS = 12_000;

export interface AgentMemoryDocument {
  relativePath: string;
  content: string;
}

export interface AgentLearningReviewInput {
  taskId: string;
  phase: 'inspect' | 'complete';
  memoryDecision?: string;
  skillDecision?: string;
  /** Derived summary only: original records are retained. */
  consolidation?: {
    fingerprint: string;
    content: string;
    sourcePaths: string[];
  };
  deferReason?: string;
}

export type AgentLearningReviewRequest = AgentLearningReviewInput & {
  kind: 'learning-review';
  source_session_id: string;
};

export type AgentLearningReviewResult = AgentLearningStatus & {
  memories?: AgentMemoryDocument[];
  reviewed?: boolean;
};

interface LearningReview {
  taskId: string;
  sessionId: string;
  completedAt: string;
  memoryDecision: string;
  skillDecision: string;
  deferReason?: string;
}

interface LearningState {
  version: 1;
  pendingUpdates: number;
  observedFingerprint?: string;
  summary?: {
    fingerprint: string;
    content: string;
    sourcePaths: string[];
    updatedAt: string;
    sessionId: string;
    taskId: string;
  };
  reviews: LearningReview[];
}

export interface AgentLearningStatus {
  fingerprint: string;
  pendingUpdates: number;
  memoryCharacters: number;
  consolidationDue: boolean;
  summary?: NonNullable<LearningState['summary']>;
  reviews: LearningReview[];
}

function readState(workspace: string): LearningState {
  const target = path.join(workspace, AGENT_LEARNING_PATH);
  if (!existsSync(target)) return { version: 1, pendingUpdates: 0, reviews: [] };
  // Do not silently overwrite a damaged state file or claim its review succeeded.
  const value = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/u, '')) as LearningState;
  if (
    value.version !== 1 ||
    !Array.isArray(value.reviews) ||
    !Number.isSafeInteger(value.pendingUpdates) ||
    value.pendingUpdates < 0
  ) {
    throw new Error('Invalid agent learning state');
  }
  return value;
}

function writeState(workspace: string, state: LearningState): void {
  const target = path.join(workspace, AGENT_LEARNING_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function agentMemoryFingerprint(memories: AgentMemoryDocument[]): string {
  const hash = createHash('sha256');
  for (const memory of [...memories].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'en')
  )) {
    hash
      .update(memory.relativePath)
      .update('\0')
      .update(memory.content.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n'))
      .update('\0');
  }
  return hash.digest('hex');
}

export function getAgentLearningStatus(
  workspace: string,
  memories: AgentMemoryDocument[]
): AgentLearningStatus {
  const state = readState(workspace);
  const fingerprint = agentMemoryFingerprint(memories);
  const memoryCharacters = memories.reduce(
    (total, memory) =>
      total + memory.content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/u, '').length,
    0
  );
  // Old workspaces and direct file edits also participate, without needing migration.
  const pendingUpdates = state.observedFingerprint
    ? state.pendingUpdates + (state.observedFingerprint === fingerprint ? 0 : 1)
    : Math.max(state.pendingUpdates, memories.length);
  const summary = state.summary?.fingerprint === fingerprint ? state.summary : undefined;
  return {
    fingerprint,
    pendingUpdates,
    memoryCharacters,
    consolidationDue:
      memories.length > 0 &&
      !summary &&
      (pendingUpdates >= AGENT_MEMORY_REVIEW_UPDATES ||
        memoryCharacters >= AGENT_MEMORY_REVIEW_CHARACTERS),
    summary,
    reviews: state.reviews,
  };
}

/** Called only by an authorized managed-memory mutation, after the files changed. */
export function recordAgentMemoryChange(workspace: string, memories: AgentMemoryDocument[]): void {
  const state = readState(workspace);
  const status = getAgentLearningStatus(workspace, memories);
  if (state.observedFingerprint === status.fingerprint) return;
  writeState(workspace, {
    ...state,
    observedFingerprint: status.fingerprint,
    pendingUpdates: status.pendingUpdates,
  });
}

/** The caller must authorize the current agent/session/task before committing. */
export function completeAgentLearningReview(options: {
  workspace: string;
  memories: AgentMemoryDocument[];
  sessionId: string;
  input: AgentLearningReviewInput;
  now?: string;
}): AgentLearningStatus {
  const { workspace, memories, sessionId, input } = options;
  const status = getAgentLearningStatus(workspace, memories);
  const state = readState(workspace);
  if (!input.memoryDecision?.trim() || !input.skillDecision?.trim()) {
    throw new Error(
      'Both memoryDecision and skillDecision are required, including when no change is useful'
    );
  }
  if (status.consolidationDue && !input.consolidation && !input.deferReason?.trim()) {
    throw new Error(
      'Memory consolidation is due: inspect the current snapshot and provide a summary, or explain why it must be deferred'
    );
  }
  const completedAt = options.now ?? new Date().toISOString();
  if (input.consolidation) {
    const expectedPaths = memories.map((memory) => memory.relativePath).sort();
    const suppliedPaths = [...input.consolidation.sourcePaths].sort();
    if (
      input.consolidation.fingerprint !== status.fingerprint ||
      JSON.stringify(suppliedPaths) !== JSON.stringify(expectedPaths)
    ) {
      throw new Error('Memory changed during review; inspect again before submitting a summary');
    }
    if (!input.consolidation.content.trim() || input.consolidation.content.length > 24_000) {
      throw new Error('Memory summary must contain 1 to 24000 characters');
    }
    state.summary = {
      ...input.consolidation,
      content: input.consolidation.content.trim(),
      sourcePaths: expectedPaths,
      updatedAt: completedAt,
      sessionId,
      taskId: input.taskId,
    };
  }
  state.pendingUpdates = input.consolidation ? 0 : status.pendingUpdates;
  state.observedFingerprint = status.fingerprint;
  state.reviews = [
    ...state.reviews.filter((review) => review.taskId !== input.taskId),
    {
      taskId: input.taskId,
      sessionId,
      completedAt,
      memoryDecision: input.memoryDecision.trim(),
      skillDecision: input.skillDecision.trim(),
      ...(input.deferReason?.trim() ? { deferReason: input.deferReason.trim() } : {}),
    },
  ].slice(-64);
  writeState(workspace, state);
  return getAgentLearningStatus(workspace, memories);
}
