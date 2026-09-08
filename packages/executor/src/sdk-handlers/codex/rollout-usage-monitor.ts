import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextUsageSnapshot } from '@disco/core/types';
import type { TokenUsage } from '../../types/token-usage.js';
import {
  extractCodexContextSnapshotFromEvent,
  extractCodexTokenCountUsageFromEvent,
  subtractCodexTokenUsage,
} from './usage.js';

export interface CodexRolloutUsageSnapshot {
  usage: TokenUsage;
  observedAt: string;
  rawContextUsage?: ContextUsageSnapshot;
}

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cache_read_tokens: 0,
};

const ROLLOUT_LOCATE_RETRY_MS = 2_000;

function validEventTimestamp(raw: unknown): { iso: string; milliseconds: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const timestamp = (raw as Record<string, unknown>).timestamp;
  if (typeof timestamp !== 'string') return undefined;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function usageFingerprint(observedAt: string, usage: TokenUsage): string {
  return [
    observedAt,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.total_tokens ?? 0,
    usage.cache_read_tokens ?? 0,
  ].join(':');
}

/** Locate the Codex JSONL rollout that owns a thread. */
export async function findCodexRolloutFile(
  threadId: string,
  codexHomeCandidates: readonly string[]
): Promise<string | undefined> {
  if (!threadId) return undefined;

  async function walk(directory: string): Promise<string | undefined> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = await walk(fullPath);
        if (found) return found;
      }
    }
    return undefined;
  }

  for (const codexHome of codexHomeCandidates) {
    const found = await walk(path.join(codexHome, 'sessions'));
    if (found) return found;
  }
  return undefined;
}

/** Read the latest context snapshot for legacy/final fallback paths. */
export async function extractLatestContextUsageFromRollout(
  threadId: string,
  codexHomeCandidates: readonly string[]
): Promise<ContextUsageSnapshot | undefined> {
  const rolloutPath = await findCodexRolloutFile(threadId, codexHomeCandidates);
  if (!rolloutPath) return undefined;

  let contents: string;
  try {
    contents = await fs.readFile(rolloutPath, 'utf8');
  } catch {
    return undefined;
  }

  let latest: ContextUsageSnapshot | undefined;
  for (const line of contents.split('\n')) {
    if (!line.includes('token_count')) continue;
    try {
      latest = extractCodexContextSnapshotFromEvent(JSON.parse(line) as unknown) ?? latest;
    } catch {
      // Ignore malformed / partially-written JSONL lines.
    }
  }
  return latest;
}

/**
 * Incrementally tails a Codex rollout and converts lifetime token counters into
 * this turn's cumulative usage. The Codex SDK does not expose token_count on
 * its public stdout stream, even though the CLI writes those events to JSONL.
 */
export class CodexRolloutUsageMonitor {
  private threadId?: string;
  private rolloutPath?: string;
  private offset = 0;
  private remainder = Buffer.alloc(0);
  private baseline?: TokenUsage;
  private latestUsage?: TokenUsage;
  private latestContextUsage?: ContextUsageSnapshot;
  private latestObservedAt?: string;
  private lastEmittedFingerprint?: string;
  private nextLocateAtMs = 0;
  private observedCurrentTurn = false;

  constructor(
    private readonly codexHomeCandidates: readonly string[],
    private readonly startedAtMs = Date.now()
  ) {}

  getLatestUsage(): TokenUsage | undefined {
    return this.latestUsage;
  }

  getLatestContextUsage(): ContextUsageSnapshot | undefined {
    return this.latestContextUsage;
  }

  getLatestObservedAt(): string | undefined {
    return this.latestObservedAt;
  }

  /** Establish a pre-turn lifetime baseline for an existing Codex thread. */
  async primeExistingThread(threadId: string): Promise<void> {
    this.setThreadId(threadId);
    await this.readAvailable({ baselineOnly: true, forceLocate: true });
  }

  /** Return every new per-turn usage snapshot written since the previous poll. */
  async poll(threadId?: string, forceLocate = false): Promise<CodexRolloutUsageSnapshot[]> {
    if (threadId) this.setThreadId(threadId);
    return this.readAvailable({ baselineOnly: false, forceLocate });
  }

  private setThreadId(threadId: string): void {
    if (!threadId || this.threadId === threadId) return;
    this.threadId = threadId;
    this.rolloutPath = undefined;
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.baseline = undefined;
    this.latestUsage = undefined;
    this.latestContextUsage = undefined;
    this.latestObservedAt = undefined;
    this.lastEmittedFingerprint = undefined;
    this.nextLocateAtMs = 0;
    this.observedCurrentTurn = false;
  }

  private async ensureRolloutPath(forceLocate: boolean): Promise<boolean> {
    if (this.rolloutPath) return true;
    if (!this.threadId) return false;
    const now = Date.now();
    if (!forceLocate && now < this.nextLocateAtMs) return false;
    this.nextLocateAtMs = now + ROLLOUT_LOCATE_RETRY_MS;
    this.rolloutPath = await findCodexRolloutFile(this.threadId, this.codexHomeCandidates);
    if (this.rolloutPath) this.nextLocateAtMs = 0;
    return this.rolloutPath !== undefined;
  }

  private async readAvailable({
    baselineOnly,
    forceLocate,
  }: {
    baselineOnly: boolean;
    forceLocate: boolean;
  }): Promise<CodexRolloutUsageSnapshot[]> {
    if (!(await this.ensureRolloutPath(forceLocate)) || !this.rolloutPath) return [];

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.rolloutPath, 'r');
      const stat = await handle.stat();
      if (stat.size < this.offset) {
        // Defensive recovery for an externally truncated/rotated rollout.
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
        this.baseline = undefined;
        this.observedCurrentTurn = false;
      }
      const unreadBytes = stat.size - this.offset;
      if (unreadBytes <= 0) return [];

      const chunk = Buffer.allocUnsafe(unreadBytes);
      let bytesRead = 0;
      while (bytesRead < unreadBytes) {
        const result = await handle.read(
          chunk,
          bytesRead,
          unreadBytes - bytesRead,
          this.offset + bytesRead
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      this.offset += bytesRead;

      const combined = Buffer.concat([this.remainder, chunk.subarray(0, bytesRead)]);
      const snapshots: CodexRolloutUsageSnapshot[] = [];
      let lineStart = 0;
      for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(lineStart, index).toString('utf8').replace(/\r$/, '');
        lineStart = index + 1;
        const snapshot = this.processLine(line, baselineOnly);
        if (snapshot) snapshots.push(snapshot);
      }
      this.remainder = combined.subarray(lineStart);
      return snapshots;
    } catch {
      return [];
    } finally {
      await handle?.close();
    }
  }

  private processLine(line: string, baselineOnly: boolean): CodexRolloutUsageSnapshot | undefined {
    if (!line.includes('token_count')) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }

    const accounting = extractCodexTokenCountUsageFromEvent(parsed);
    if (!accounting) return undefined;

    if (baselineOnly) {
      this.baseline = accounting.cumulative;
      return undefined;
    }

    const timestamp = validEventTimestamp(parsed);
    if (timestamp && timestamp.milliseconds < this.startedAtMs) {
      // The file was discovered after execution started. Older rows still
      // establish the lifetime baseline, but must never be emitted as this task.
      this.baseline = accounting.cumulative;
      return undefined;
    }

    if (!this.observedCurrentTurn) {
      // total_token_usage is cumulative within a Codex turn, but depending on
      // CLI/protocol version it may either reset at the turn boundary or carry
      // a prior counter. In both cases, `cumulative - last` on the first row is
      // the exact pre-turn baseline. Recompute it even after priming an existing
      // rollout; otherwise a reset from millions of tokens to ~200k clamps the
      // entire new task to zero.
      this.baseline = accounting.last
        ? subtractCodexTokenUsage(accounting.cumulative, accounting.last)
        : this.baseline ?? ZERO_USAGE;
      this.observedCurrentTurn = true;
    } else if (!this.baseline) {
      this.baseline = ZERO_USAGE;
    }

    const usage = subtractCodexTokenUsage(accounting.cumulative, this.baseline);
    const observedAt = timestamp?.iso ?? new Date().toISOString();
    const rawContextUsage = extractCodexContextSnapshotFromEvent(parsed);
    this.latestUsage = usage;
    this.latestObservedAt = observedAt;
    if (rawContextUsage) this.latestContextUsage = rawContextUsage;

    const fingerprint = usageFingerprint(observedAt, usage);
    if (fingerprint === this.lastEmittedFingerprint) return undefined;
    this.lastEmittedFingerprint = fingerprint;
    return {
      usage,
      observedAt,
      ...(rawContextUsage ? { rawContextUsage } : {}),
    };
  }
}
