import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const CLASSIFIER_VERSION = 2;
const DEFAULT_EXACT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PATTERN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_CALLS_PER_MINUTE = 6;
const MIN_STABLE_PATTERN_SAMPLES = 2;

export type CommandPurposeSource = 'rule' | 'fallback' | 'exact-cache' | 'pattern-cache' | 'model';

export interface CommandPurposeClassification {
  label: string;
  confidence: number;
  source: CommandPurposeSource;
  needsModel: boolean;
}

export interface CommandPurposeModelRequest {
  command: string;
  context?: string;
  localLabel: string;
}

export interface CommandPurposeModelResult {
  label: string;
  confidence: number;
}

export type CommandPurposeModel = (
  request: CommandPurposeModelRequest
) => Promise<CommandPurposeModelResult | null>;

interface ExactCacheEntry {
  label: string;
  confidence: number;
  expiresAt: number;
  updatedAt: number;
  hits: number;
}

interface PatternCandidate {
  label: string;
  confidenceTotal: number;
  exactKeys: string[];
  updatedAt: number;
}

interface PatternCacheEntry {
  candidates: PatternCandidate[];
  expiresAt: number;
  hits: number;
}

interface CommandPurposeCacheState {
  version: number;
  exact: Record<string, ExactCacheEntry>;
  patterns: Record<string, PatternCacheEntry>;
}

export interface CommandPurposeClassifierOptions {
  cacheFile?: string;
  model?: CommandPurposeModel;
  now?: () => number;
  exactTtlMs?: number;
  patternTtlMs?: number;
  maxModelCallsPerMinute?: number;
}

function emptyState(): CommandPurposeCacheState {
  return { version: CLASSIFIER_VERSION, exact: {}, patterns: {} };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compactWhitespace(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact keys intentionally include the complete normalized command. They are
 * hashed before persistence so cache files cannot reveal user paths or prompt
 * fragments.
 */
export function commandPurposeExactKey(command: string): string {
  return hash(`${CLASSIFIER_VERSION}\0${compactWhitespace(command).toLowerCase()}`);
}

function pathToken(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const extension = path.posix.extname(normalized).toLowerCase();
  return extension && extension.length <= 10 ? `<path:${extension}>` : '<path>';
}

/**
 * Pattern keys retain commands/cmdlets and file types while removing volatile
 * paths, UUIDs, hashes and numbers. Two genuinely similar command shapes can
 * therefore share a learned label without storing either command as plaintext.
 */
export function normalizeCommandPurposePattern(command: string): string {
  return compactWhitespace(command)
    .toLowerCase()
    .replace(
      /(["'])([a-z]:\\[^"']+|\/[^"]+)\1/giu,
      (_match, quote, target) => `${quote}${pathToken(String(target))}${quote}`
    )
    .replace(/[a-z]:\\[^\s"'|;]+/giu, (match) => pathToken(match))
    .replace(/\/(?:[^\s"'|;]+\/)+[^\s"'|;]*/gu, (match) => pathToken(match))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\b[0-9a-f]{20,}\b/giu, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/gu, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function commandPurposePatternKey(command: string): string {
  return hash(`${CLASSIFIER_VERSION}\0${normalizeCommandPurposePattern(command)}`);
}

function localResult(label: string, confidence: number): CommandPurposeClassification {
  return {
    label,
    confidence,
    source: confidence >= 0.86 ? 'rule' : 'fallback',
    needsModel: confidence < 0.86,
  };
}

/**
 * Small, deterministic first pass. Order is deliberate: compound intent wins
 * over incidental cmdlets such as Get-Item so a media inspection command is
 * not reduced to the generic "check file information" label.
 */
export function classifyCommandPurposeLocally(command: string): CommandPurposeClassification {
  const value = compactWhitespace(command);
  const lower = value.toLowerCase();

  const hasMediaProbe = /\b(ffmpeg|ffprobe|ncmdump|mediainfo)\b/u.test(lower);
  const hasToolLookup = /\b(where(?:\.exe)?|get-command)\b/u.test(lower);
  const hasHexInspection = /\b(format-hex|xxd|hexdump)\b/u.test(lower);
  const hasFileMetadata = /\b(get-item|stat)\b/u.test(lower);
  const hasGitCli = /(?:^|[\s;&|"'(\\/])git(?:\.exe)?(?=\s|$|["'])/u.test(lower);

  if (hasFileMetadata && hasHexInspection && hasMediaProbe) {
    return localResult('检查媒体文件与转码工具', 0.97);
  }
  if (hasHexInspection && hasToolLookup) {
    return localResult('检查文件格式与工具环境', 0.94);
  }
  if (hasMediaProbe && /\b(-i|convert|transcode|libmp3lame|\.mp3|\.mp4|\.wav)\b/u.test(lower)) {
    return localResult('转换并检查媒体文件', 0.92);
  }
  if (/\b(vitest|jest|pytest|cargo\s+test|go\s+test|pnpm\b.*\btest|npm\s+test)\b/u.test(lower)) {
    return localResult('运行项目测试', 0.96);
  }
  if (/\b(tsc|typecheck|check-types)\b/u.test(lower)) {
    return localResult('检查项目类型', 0.95);
  }
  if (/\b(eslint|biome|prettier|lint)\b/u.test(lower)) {
    return localResult('检查代码质量', 0.94);
  }
  if (hasGitCli && /\bgit(?:\.exe)?["']?\s+(?:--version|version|help|--help)\b/u.test(lower)) {
    return localResult('检查 Git 工具', 0.97);
  }
  if (hasGitCli && /\bgit(?:\.exe)?["']?\s+(status|diff|log|show|shortlog|blame)\b/u.test(lower)) {
    return localResult('检查代码变更', 0.95);
  }
  if (
    hasGitCli &&
    /\bgit(?:\.exe)?["']?\s+(rev-parse|branch|worktree|remote|config|tag|describe)\b/u.test(lower)
  ) {
    return localResult('检查 Git 工作区', 0.94);
  }
  if (hasGitCli && /\bgit(?:\.exe)?["']?\s+(clone|fetch|pull)\b/u.test(lower)) {
    return localResult('获取代码更新', 0.94);
  }
  if (hasGitCli && /\bgit(?:\.exe)?["']?\s+push\b/u.test(lower)) {
    return localResult('推送代码更新', 0.95);
  }
  if (hasGitCli && /\bgit(?:\.exe)?["']?\s+(add|commit|stash)\b/u.test(lower)) {
    return localResult('记录代码变更', 0.94);
  }
  if (
    hasGitCli &&
    /\bgit(?:\.exe)?["']?\s+(checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|revert)\b/u.test(
      lower
    )
  ) {
    return localResult('调整 Git 工作区', 0.94);
  }
  if (hasGitCli) return localResult('执行 Git 操作', 0.88);
  if (/\b(rg|grep|findstr|select-string)\b/u.test(lower)) {
    return localResult('查找代码和文本', 0.89);
  }
  if (/\b(get-content|readalltext|\bcat\b|\btype\b)\b/u.test(lower)) {
    return localResult('读取文件内容', 0.88);
  }
  if (/\b(set-content|add-content|out-file|writealltext|apply_patch)\b/u.test(lower)) {
    return localResult('修改文件内容', 0.9);
  }
  if (/\b(curl(?:\.exe)?|invoke-webrequest|wget|requests\.get|httpx|fetch\s*\()\b/u.test(lower)) {
    return localResult('请求网页或接口', 0.88);
  }
  if (hasToolLookup) return localResult('检查本机可用工具', 0.88);
  if (/\b(get-process|get-ciminstance|tasklist)\b/u.test(lower)) {
    return localResult('检查运行进程', 0.91);
  }
  if (/\b(get-childitem|\bdir\b|\bls\b)\b/u.test(lower)) {
    return localResult('浏览工作区文件', 0.87);
  }
  if (/\b(remove-item|\brm\b|\bdel\b)\b/u.test(lower)) {
    return localResult('清理文件', 0.87);
  }
  if (/\b(copy-item|move-item|\bcp\b|\bmv\b)\b/u.test(lower)) {
    return localResult('整理文件', 0.87);
  }
  if (hasFileMetadata) return localResult('检查文件信息', 0.72);
  if (/\bpython(?:\.exe|3)?\b/u.test(lower)) return localResult('运行 Python 脚本', 0.58);
  if (/\b(powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/u.test(lower)) {
    return localResult('执行 PowerShell 命令', 0.48);
  }
  if (/\b(cmd(?:\.exe)?|bash|sh)\b/u.test(lower)) return localResult('执行工作区命令', 0.42);
  return localResult('执行工作区操作', 0.3);
}

export function normalizeCommandPurposeLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/^(?:正在|已经|已)(?:执行|运行|处理|使用)?\s*/u, '')
    .replace(/[。！？!?：:；;]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(label);
  if (characters.length < 4 || characters.length > 28) return '';
  if (
    /^(?:powershell|python|bash|shell|js|命令|脚本|执行命令|运行脚本|处理数据|工作区操作)$/iu.test(
      label
    )
  ) {
    return '';
  }
  return label;
}

export function resolveCommandPurposeCacheFile(
  scope: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const dataHome = env.DISCO_DATA_HOME?.trim()
    ? path.resolve(env.DISCO_DATA_HOME.trim())
    : path.join(os.homedir(), '.disco');
  return path.join(dataHome, 'cache', 'command-purpose', `${hash(scope).slice(0, 24)}.json`);
}

export class CommandPurposeClassifier {
  private readonly cacheFile: string;
  private readonly model?: CommandPurposeModel;
  private readonly now: () => number;
  private readonly exactTtlMs: number;
  private readonly patternTtlMs: number;
  private readonly maxModelCallsPerMinute: number;
  private state: CommandPurposeCacheState = emptyState();
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Promise<CommandPurposeClassification>>();
  private modelCallTimes: number[] = [];

  constructor(options: CommandPurposeClassifierOptions = {}) {
    this.cacheFile =
      options.cacheFile ?? path.join(os.tmpdir(), 'disco-command-purpose-cache.json');
    this.model = options.model;
    this.now = options.now ?? Date.now;
    this.exactTtlMs = options.exactTtlMs ?? DEFAULT_EXACT_TTL_MS;
    this.patternTtlMs = options.patternTtlMs ?? DEFAULT_PATTERN_TTL_MS;
    this.maxModelCallsPerMinute = options.maxModelCallsPerMinute ?? DEFAULT_MODEL_CALLS_PER_MINUTE;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.cacheFile, 'utf8')
      ) as Partial<CommandPurposeCacheState>;
      if (parsed.version === CLASSIFIER_VERSION && parsed.exact && parsed.patterns) {
        this.state = {
          version: CLASSIFIER_VERSION,
          exact: parsed.exact,
          patterns: parsed.patterns,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A malformed cache must never affect command execution.
        this.state = emptyState();
      }
    }
    this.pruneExpired();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of Object.entries(this.state.exact)) {
      if (!entry || entry.expiresAt <= now) delete this.state.exact[key];
    }
    for (const [key, entry] of Object.entries(this.state.patterns)) {
      if (!entry || entry.expiresAt <= now) delete this.state.patterns[key];
    }
  }

  private bestPattern(entry: PatternCacheEntry | undefined): PatternCandidate | undefined {
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    const candidates = [...entry.candidates].sort((left, right) => {
      const sampleDelta = right.exactKeys.length - left.exactKeys.length;
      if (sampleDelta !== 0) return sampleDelta;
      return (
        right.confidenceTotal / Math.max(1, right.exactKeys.length) -
        left.confidenceTotal / Math.max(1, left.exactKeys.length)
      );
    });
    const best = candidates[0];
    if (!best || best.exactKeys.length < MIN_STABLE_PATTERN_SAMPLES) return undefined;
    const runnerUp = candidates[1];
    if (runnerUp && runnerUp.exactKeys.length === best.exactKeys.length) return undefined;
    return best;
  }

  async classifyImmediate(command: string): Promise<CommandPurposeClassification> {
    await this.ensureLoaded();
    const exactKey = commandPurposeExactKey(command);
    const exact = this.state.exact[exactKey];
    if (exact && exact.expiresAt > this.now()) {
      exact.hits += 1;
      return {
        label: exact.label,
        confidence: exact.confidence,
        source: 'exact-cache',
        needsModel: false,
      };
    }

    const pattern = this.state.patterns[commandPurposePatternKey(command)];
    const best = this.bestPattern(pattern);
    if (best && pattern) {
      pattern.hits += 1;
      const confidence = best.confidenceTotal / best.exactKeys.length;
      return {
        label: best.label,
        confidence,
        source: 'pattern-cache',
        needsModel: false,
      };
    }

    return classifyCommandPurposeLocally(command);
  }

  private canCallModel(): boolean {
    if (!this.model || this.maxModelCallsPerMinute <= 0) return false;
    const cutoff = this.now() - 60_000;
    this.modelCallTimes = this.modelCallTimes.filter((timestamp) => timestamp > cutoff);
    if (this.modelCallTimes.length >= this.maxModelCallsPerMinute) return false;
    this.modelCallTimes.push(this.now());
    return true;
  }

  private async save(): Promise<void> {
    this.pruneExpired();
    const serialized = JSON.stringify(this.state);
    this.saveQueue = this.saveQueue.then(async () => {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const temporary = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, serialized, 'utf8');
      try {
        await fs.rename(temporary, this.cacheFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
        await fs.unlink(this.cacheFile).catch(() => undefined);
        await fs.rename(temporary, this.cacheFile);
      }
    });
    await this.saveQueue;
  }

  private learn(command: string, result: CommandPurposeModelResult): CommandPurposeClassification {
    const now = this.now();
    const exactKey = commandPurposeExactKey(command);
    const patternKey = commandPurposePatternKey(command);
    this.state.exact[exactKey] = {
      label: result.label,
      confidence: result.confidence,
      updatedAt: now,
      expiresAt: now + this.exactTtlMs,
      hits: 0,
    };

    const pattern = this.state.patterns[patternKey] ?? {
      candidates: [],
      expiresAt: now + this.patternTtlMs,
      hits: 0,
    };
    let candidate = pattern.candidates.find((entry) => entry.label === result.label);
    if (!candidate) {
      candidate = { label: result.label, confidenceTotal: 0, exactKeys: [], updatedAt: now };
      pattern.candidates.push(candidate);
    }
    if (!candidate.exactKeys.includes(exactKey)) {
      candidate.exactKeys.push(exactKey);
      candidate.confidenceTotal += result.confidence;
    }
    candidate.updatedAt = now;
    pattern.expiresAt = now + this.patternTtlMs;
    pattern.candidates = pattern.candidates
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 6);
    this.state.patterns[patternKey] = pattern;

    return {
      label: result.label,
      confidence: result.confidence,
      source: 'model',
      needsModel: false,
    };
  }

  async refine(command: string, context?: string): Promise<CommandPurposeClassification> {
    const immediate = await this.classifyImmediate(command);
    if (!immediate.needsModel) return immediate;

    const exactKey = commandPurposeExactKey(command);
    const existing = this.pending.get(exactKey);
    if (existing) return existing;
    if (!this.canCallModel()) return immediate;

    const pending = (async () => {
      try {
        const raw = await this.model?.({
          command: compactWhitespace(command).slice(0, 6000),
          context: context ? compactWhitespace(context).slice(0, 800) : undefined,
          localLabel: immediate.label,
        });
        const label = normalizeCommandPurposeLabel(raw?.label);
        const confidence = Number(raw?.confidence);
        if (!label || !Number.isFinite(confidence) || confidence < 0.65 || confidence > 1) {
          return immediate;
        }
        const learned = this.learn(command, { label, confidence });
        await this.save();
        return learned;
      } catch {
        return immediate;
      } finally {
        this.pending.delete(exactKey);
      }
    })();
    this.pending.set(exactKey, pending);
    return pending;
  }
}
