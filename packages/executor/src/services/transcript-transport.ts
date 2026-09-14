import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EXECUTOR_TRANSCRIPT_CHUNK_BYTES } from '@disco/core/config';
import type {
  ExecutorTranscriptRequest,
  ExecutorTranscriptResponse,
  ExecutorTranscriptTransfer,
  Message,
} from '@disco/core/types';

type Send = (request: ExecutorTranscriptRequest) => Promise<ExecutorTranscriptResponse>;

/** Retry the same transfer/offset after a lost acknowledgement, never a new write. */
async function sendPacket(send: Send, request: ExecutorTranscriptRequest) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(request);
    } catch (error) {
      const failure = error as { code?: number; message?: string };
      const transient =
        failure.code === 408 ||
        failure.code === 502 ||
        failure.code === 503 ||
        failure.code === 504 ||
        /timed?\s*out|timeout|disconnected|connection (?:closed|reset)|socket hang up/i.test(
          failure.message ?? ''
        );
      if (!transient || attempt >= 2) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}

export async function transferTranscript(
  send: Send,
  executorSessionToken: string,
  method: 'create' | 'patch',
  messageId: string,
  bytes: Buffer
): Promise<Message> {
  const transfer: ExecutorTranscriptTransfer = {
    transferId: randomUUID(),
    method,
    messageId,
    totalBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    for (let offset = 0; offset < bytes.length; offset += EXECUTOR_TRANSCRIPT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + EXECUTOR_TRANSCRIPT_CHUNK_BYTES);
      const response = await sendPacket(send, {
        ...transfer,
        executorSessionToken,
        action: 'append',
        offset,
        chunk: chunk.toString('base64'),
      });
      if (response.nextOffset !== offset + chunk.length) {
        throw new Error('Transcript transfer acknowledgement does not match the sent bytes');
      }
    }
    const response = await sendPacket(send, {
      ...transfer,
      executorSessionToken,
      action: 'commit',
    });
    if (!response.message || response.message.message_id !== messageId) {
      throw new Error('Transcript transfer did not confirm the saved message');
    }
    return response.message;
  } catch (error) {
    // No partial transcript reaches the database. Discard abandoned staging
    // when possible; the daemon also expires it if the connection is gone.
    await send({ action: 'abort', transferId: transfer.transferId, executorSessionToken }).catch(
      () => undefined
    );
    throw error;
  }
}
