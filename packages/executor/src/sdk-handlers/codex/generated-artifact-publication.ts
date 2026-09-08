import * as path from 'node:path';
import { DISCO_MCP_METHOD_NAMES } from '@disco/core';

export interface ArtifactPublicationToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string | Array<Record<string, unknown>>;
  status?: string;
}

type FetchLike = typeof fetch;

const NATIVE_GENERATED_ARTIFACT_TOOLS = new Set([
  'image_generation',
  'audio_generation',
  'video_generation',
  'pdf_generation',
  'document_generation',
  'archive_generation',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsedOutputValues(output: ArtifactPublicationToolUse['output']): unknown[] {
  if (typeof output === 'string') {
    try {
      return [JSON.parse(output) as unknown];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(output)) return [];
  const values: unknown[] = [];
  for (const block of output) {
    if (!block || typeof block !== 'object') continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== 'string') continue;
    try {
      values.push(JSON.parse(text) as unknown);
    } catch {
      // Dynamic-tool text is not an artifact declaration unless it is JSON.
    }
  }
  return values;
}

function generatedPathsFromValue(value: unknown): string[] {
  const payload = record(value);
  if (!payload) return [];
  const paths: string[] = [];
  for (const key of ['savedPath', 'saved_path']) {
    const candidate = payload[key];
    if (typeof candidate === 'string' && candidate.trim()) paths.push(candidate.trim());
  }
  for (const key of ['savedPaths', 'saved_paths']) {
    const candidates = payload[key];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) paths.push(candidate.trim());
    }
  }
  const artifacts = payload.artifacts;
  if (payload.type === 'disco_generated_artifacts' && Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      const artifactPath = record(artifact)?.path;
      if (typeof artifactPath === 'string' && artifactPath.trim()) {
        paths.push(artifactPath.trim());
      }
    }
  }
  return paths;
}

function publicationOperation(toolUse: ArtifactPublicationToolUse): string | undefined {
  return toolUse.name.split('.').at(-1);
}

function isSuccessfulPublication(toolUse: ArtifactPublicationToolUse): boolean {
  if (toolUse.status === 'failed' || toolUse.status === 'error') return false;
  const operation = publicationOperation(toolUse);
  if (
    operation !== DISCO_MCP_METHOD_NAMES.filesPublish &&
    !(
      operation === DISCO_MCP_METHOD_NAMES.execute &&
      toolUse.input.tool_name === DISCO_MCP_METHOD_NAMES.filesPublish
    )
  ) {
    return false;
  }
  return parsedOutputValues(toolUse.output).some((value) => {
    const payload = record(value);
    return payload?.type === 'disco_file_publication' && payload.published === true;
  });
}

function publicationInputPaths(toolUse: ArtifactPublicationToolUse): string[] {
  const operation = publicationOperation(toolUse);
  const input =
    operation === DISCO_MCP_METHOD_NAMES.execute ? record(toolUse.input.arguments) : toolUse.input;
  const files = input?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((candidate) => {
    const filePath = record(candidate)?.path;
    return typeof filePath === 'string' && filePath.trim() ? [filePath.trim()] : [];
  });
}

function comparablePath(filePath: string): string {
  const normalized = path.normalize(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Return only host-declared generated artifacts. Shell output and ordinary
 * file changes are deliberately ignored: those remain explicitly published
 * by the Agent through disco_files_publish.
 */
export function generatedArtifactPathsFromToolUses(
  toolUses: ReadonlyArray<ArtifactPublicationToolUse>
): string[] {
  const alreadyPublished = new Set(
    toolUses.filter(isSuccessfulPublication).flatMap(publicationInputPaths).map(comparablePath)
  );
  const generated = new Map<string, string>();
  for (const toolUse of toolUses) {
    if (toolUse.status === 'failed' || toolUse.status === 'error') continue;
    const operation = publicationOperation(toolUse) ?? toolUse.name;
    const acceptsStructuredDeclaration = toolUse.name.startsWith('client.');
    if (!NATIVE_GENERATED_ARTIFACT_TOOLS.has(operation) && !acceptsStructuredDeclaration) {
      continue;
    }
    for (const value of parsedOutputValues(toolUse.output)) {
      const payload = record(value);
      if (acceptsStructuredDeclaration && payload?.type !== 'disco_generated_artifacts') {
        continue;
      }
      for (const filePath of generatedPathsFromValue(value)) {
        const key = comparablePath(filePath);
        if (!alreadyPublished.has(key)) generated.set(key, filePath);
      }
    }
  }
  return [...generated.values()];
}

interface JsonRpcToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface JsonRpcResponse {
  result?: JsonRpcToolCallResult;
  error?: { code?: number; message?: string; data?: unknown };
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  const payload = record(value);
  return Boolean(payload && ('result' in payload || 'error' in payload));
}

/**
 * Disco's MCP endpoint supports both modern bounded JSON responses and the
 * request-scoped SSE response used by legacy/stateless clients. The automatic
 * publication bridge deliberately avoids retaining an MCP client session, so
 * a direct tools/call may validly take either form.
 */
async function readJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    const payload = (await response.json()) as unknown;
    if (isJsonRpcResponse(payload)) return payload;
    throw new Error('文件发布服务返回了无效 JSON-RPC 结果');
  }

  const body = await response.text();
  for (const event of body.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data) as unknown;
      if (isJsonRpcResponse(payload)) return payload;
    } catch {
      // Ignore comments, keep-alives and unrelated events; a bounded MCP
      // response must still contain one valid JSON-RPC message below.
    }
  }
  throw new Error('文件发布服务未返回有效的 MCP 事件');
}

function publicationPayloadFromRpc(result: JsonRpcToolCallResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      // Keep looking for the structured publication marker.
    }
  }
  return undefined;
}

function publicationSucceeded(value: unknown): boolean {
  const payload = record(value);
  return payload?.type === 'disco_file_publication' && payload.published === true;
}

function failureToolUse(id: string, files: string[], error: unknown): ArtifactPublicationToolUse {
  return {
    id,
    name: `disco.${DISCO_MCP_METHOD_NAMES.filesPublish}`,
    input: { files: files.map((filePath) => ({ path: filePath })), automatic: true },
    output: error instanceof Error ? error.message : String(error),
    status: 'failed',
  };
}

/**
 * Publish generated artifacts through the exact same authenticated,
 * session-owned MCP method used by Agents. The synthetic tool uses are fed
 * back into the existing attachment parser, keeping one result contract for
 * images, PDF, audio, video and ordinary files.
 */
export async function publishGeneratedArtifacts(input: {
  daemonUrl: string;
  sessionToken: string | undefined;
  filePaths: ReadonlyArray<string>;
  fetchImpl?: FetchLike;
}): Promise<ArtifactPublicationToolUse[]> {
  const uniqueFiles = [
    ...new Map(input.filePaths.map((filePath) => [comparablePath(filePath), filePath])).values(),
  ];
  if (uniqueFiles.length === 0) return [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const calls: ArtifactPublicationToolUse[] = [];
  for (let offset = 0; offset < uniqueFiles.length; offset += 20) {
    const files = uniqueFiles.slice(offset, offset + 20);
    const id = `disco-auto-publish-${offset / 20 + 1}`;
    if (!input.sessionToken) {
      calls.push(failureToolUse(id, files, new Error('当前会话缺少文件发布凭据')));
      continue;
    }
    try {
      const response = await fetchImpl(`${input.daemonUrl.replace(/\/$/u, '')}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.sessionToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: DISCO_MCP_METHOD_NAMES.filesPublish,
            arguments: { files: files.map((filePath) => ({ path: filePath })) },
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`文件发布服务返回 HTTP ${response.status}`);
      }
      const rpc = await readJsonRpcResponse(response);
      if (rpc.error) {
        throw new Error(rpc.error.message || `文件发布调用失败 (${rpc.error.code ?? 'unknown'})`);
      }
      const result = rpc.result;
      const payload = result ? publicationPayloadFromRpc(result) : undefined;
      if (!result || result.isError || !publicationSucceeded(payload)) {
        throw new Error('文件发布服务未返回有效发布结果');
      }
      calls.push({
        id,
        name: `disco.${DISCO_MCP_METHOD_NAMES.filesPublish}`,
        input: { files: files.map((filePath) => ({ path: filePath })), automatic: true },
        output: JSON.stringify(payload),
        status: 'completed',
      });
    } catch (error) {
      calls.push(failureToolUse(id, files, error));
    }
  }
  return calls;
}
