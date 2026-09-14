import type { Message } from './message';

/** One packet in a lossless executor message transfer, not a message size limit. */
export interface ExecutorTranscriptTransfer {
  transferId: string;
  method: 'create' | 'patch';
  messageId: string;
  totalBytes: number;
  sha256: string;
}

export type ExecutorTranscriptRequest = { executorSessionToken: string } & (
  | (ExecutorTranscriptTransfer & { action: 'append'; offset: number; chunk: string })
  | (ExecutorTranscriptTransfer & { action: 'commit' })
  | { action: 'abort'; transferId: string }
);

export interface ExecutorTranscriptResponse {
  nextOffset?: number;
  message?: Message;
}
