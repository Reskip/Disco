import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXECUTOR_TRANSCRIPT_CHUNK_BYTES } from '@disco/core/config';
import { BadRequest, Conflict, Forbidden, NotAuthenticated } from '@disco/core/feathers';
import type {
  AuthenticatedParams,
  ExecutorTranscriptRequest,
  ExecutorTranscriptResponse,
  ExecutorTranscriptTransfer,
  Message,
  MessageCreate,
  MessagePatch,
  Paginated,
} from '@disco/core/types';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token.js';
import type { SessionTokenService } from './session-token-service.js';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

interface Messages {
  get(id: string, params: AuthenticatedParams): Promise<Message>;
  find(params: AuthenticatedParams): Promise<Message[] | Paginated<Message>>;
  create(data: MessageCreate, params: AuthenticatedParams): Promise<Message>;
  patch(id: string, data: MessagePatch, params: AuthenticatedParams): Promise<Message>;
}

interface TransferState extends ExecutorTranscriptTransfer {
  completed?: boolean;
}

/** Lossless staging. Only a verified, complete JSON payload reaches messages. */
export class ExecutorTranscriptsService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly tokens: Pick<SessionTokenService, 'validateToken'>,
    private readonly messages: () => Messages,
    private readonly root = path.join(
      process.env.DISCO_DATA_HOME?.trim() || path.join(homedir(), '.disco'),
      'transcript-transfers'
    )
  ) {}

  async setup(): Promise<void> {
    await this.cleanupExpired();
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupExpired().catch(() => undefined);
      },
      60 * 60 * 1000
    );
    this.cleanupTimer.unref();
  }

  async teardown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled(this.locks.values());
  }

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(key) === pending) this.locks.delete(key);
    }
  }

  private directory(key: string): string {
    if (!SHA_PATTERN.test(key)) throw new BadRequest('Invalid transcript staging key');
    return path.join(this.root, key);
  }

  /** Inactive staging and retry receipts expire; live transfers hold the same lock. */
  async cleanupExpired(now = Date.now()): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SHA_PATTERN.test(entry.name)) continue;
      await this.locked(entry.name, async () => {
        const directory = this.directory(entry.name);
        const updated = await stat(path.join(directory, 'state.json')).catch(() => stat(directory));
        if (now - updated.mtimeMs > STAGING_TTL_MS) {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }

  private async saveState(directory: string, state: TransferState): Promise<void> {
    const temporary = path.join(directory, 'state.tmp');
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'state.json'));
  }

  async create(
    request: ExecutorTranscriptRequest,
    params: AuthenticatedParams = {}
  ): Promise<ExecutorTranscriptResponse> {
    const userId = params.user?.user_id;
    const tenantId = params.tenant?.tenant_id ?? params.tenant_id;
    if (!userId || !tenantId)
      throw new NotAuthenticated('Transcript transfer requires an identity');
    if (typeof request?.executorSessionToken !== 'string') {
      throw new Forbidden('Transcript transfer requires an executor token');
    }
    const scope = await this.tokens.validateToken(request.executorSessionToken, {
      tenantId,
      userId,
    });
    if (!scope?.task_id || scope.user_id !== userId) {
      throw new Forbidden('Transcript transfer requires a valid task-scoped executor token');
    }
    if (!ID_PATTERN.test(request.transferId))
      throw new BadRequest('Invalid transcript transfer ID');
    if (!['append', 'commit', 'abort'].includes(request.action)) {
      throw new BadRequest('Invalid transcript transfer action');
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([tenantId, userId, scope.session_id, scope.task_id, request.transferId])
      )
      .digest('hex');
    // Preserve all normal message auth, ownership, validation and event hooks.
    // Rebuild custom claims from the verified proof when Socket.IO omitted them.
    const messageParams: AuthenticatedParams = {
      ...params,
      provider: params.provider || 'socketio',
      query: {},
      authentication: {
        ...params.authentication,
        strategy: 'jwt',
        accessToken: request.executorSessionToken,
        payload: {
          type: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          session_id: scope.session_id,
          task_id: scope.task_id,
        },
      },
    };
    return this.locked(key, async () => {
      const directory = this.directory(key);
      const payloadPath = path.join(directory, 'payload.json');
      let state: TransferState | undefined;
      try {
        state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (request.action === 'abort') {
        // A missing commit ACK must not erase the receipt for a successful write.
        if (!state?.completed) await rm(directory, { recursive: true, force: true });
        return {};
      }
      if (
        !['create', 'patch'].includes(request.method) ||
        !ID_PATTERN.test(request.messageId) ||
        !Number.isSafeInteger(request.totalBytes) ||
        request.totalBytes < 1 ||
        !SHA_PATTERN.test(request.sha256)
      ) {
        throw new BadRequest('Invalid transcript transfer metadata');
      }
      const expected: ExecutorTranscriptTransfer = {
        transferId: request.transferId,
        method: request.method,
        messageId: request.messageId,
        totalBytes: request.totalBytes,
        sha256: request.sha256,
      };
      if (
        state &&
        Object.entries(expected).some(
          ([field, value]) => state?.[field as keyof TransferState] !== value
        )
      ) {
        throw new Conflict('Transcript transfer metadata changed');
      }
      if (request.action === 'append') {
        if (
          !Number.isSafeInteger(request.offset) ||
          request.offset < 0 ||
          typeof request.chunk !== 'string' ||
          request.chunk.length > Math.ceil(EXECUTOR_TRANSCRIPT_CHUNK_BYTES / 3) * 4
        )
          throw new BadRequest('Invalid transcript chunk');
        const chunk = Buffer.from(request.chunk, 'base64');
        if (
          !chunk.length ||
          chunk.length > EXECUTOR_TRANSCRIPT_CHUNK_BYTES ||
          chunk.toString('base64') !== request.chunk ||
          request.offset + chunk.length > request.totalBytes
        )
          throw new BadRequest('Invalid transcript chunk bytes');
        if (state?.completed) throw new Conflict('Transcript transfer already committed');
        if (!state) {
          if (request.offset !== 0)
            throw new Conflict('Transcript transfer must start at offset zero');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(payloadPath, Buffer.alloc(0), { mode: 0o600 });
          state = expected;
          await this.saveState(directory, state);
        }
        const file = await open(payloadPath, 'r+');
        try {
          const size = (await file.stat()).size;
          if (request.offset > size) throw new Conflict('Transcript chunk is out of order');
          // A timeout can occur after only part of a write. Check the overlap,
          // then rewrite the same bytes at the same offset without duplicating it.
          const overlap = Math.min(chunk.length, size - request.offset);
          if (overlap > 0) {
            const existing = Buffer.alloc(overlap);
            await file.read(existing, 0, overlap, request.offset);
            if (!existing.equals(chunk.subarray(0, overlap))) {
              throw new Conflict('Transcript retry changed previously received bytes');
            }
          }
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(
              chunk,
              written,
              chunk.length - written,
              request.offset + written
            );
            if (!result.bytesWritten) throw new Error('Transcript staging write made no progress');
            written += result.bytesWritten;
          }
        } finally {
          await file.close();
        }
        await this.saveState(directory, state);
        return { nextOffset: request.offset + chunk.length };
      }
      if (!state) throw new Conflict('Transcript transfer has no staged data');
      const service = this.messages();
      const getExisting = async (): Promise<Message | undefined> => {
        try {
          const found = await service.find({
            ...messageParams,
            query: {
              message_id: state.messageId,
              session_id: scope.session_id,
              task_id: scope.task_id,
              $limit: 1,
            },
          });
          const message = (Array.isArray(found) ? found : found.data)[0];
          if (!message) return undefined;
          if (message.session_id !== scope.session_id || message.task_id !== scope.task_id) {
            throw new Forbidden('Transcript message does not match executor scope');
          }
          return message;
        } catch (error) {
          if ((error as { code?: number }).code === 404) return undefined;
          throw error;
        }
      };
      if (state.completed) {
        const message = await getExisting();
        if (!message) throw new Conflict('Committed transcript message is no longer available');
        return { message };
      }
      const bytes = await readFile(payloadPath);
      if (
        bytes.length !== state.totalBytes ||
        createHash('sha256').update(bytes).digest('hex') !== state.sha256
      ) {
        throw new BadRequest('Transcript transfer integrity check failed');
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new BadRequest('Transcript transfer must contain valid UTF-8 JSON');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new BadRequest('Transcript transfer must contain a message object');
      }
      let message: Message;
      if (state.method === 'create') {
        if (
          data.message_id !== state.messageId ||
          data.session_id !== scope.session_id ||
          (data.task_id !== undefined && data.task_id !== scope.task_id)
        ) {
          throw new Forbidden('Transcript message does not match executor scope');
        }
        // Recover a lost commit ACK (including daemon restart) without creating
        // another row. A conflicting pre-existing ID is never overwritten.
        const existing = await getExisting();
        if (
          existing &&
          Object.entries(data).some(
            ([field, value]) => !isDeepStrictEqual(existing[field as keyof Message], value)
          )
        ) {
          throw new Conflict('Transcript message ID already contains different data');
        }
        message =
          existing ?? (await service.create(data as unknown as MessageCreate, messageParams));
      } else {
        if (!(await getExisting()))
          throw new BadRequest('Transcript patch requires an existing message');
        message = await service.patch(state.messageId, data as MessagePatch, messageParams);
      }
      await this.saveState(directory, { ...state, completed: true });
      await rm(payloadPath, { force: true });
      return { message };
    });
  }
}
