import type { Message } from '@disco/core/types';
import { EXECUTOR_REQUEST_DATA_BUDGET_BYTES } from './feathers-client.js';
import { truncateContentIfNeeded } from './tool-result-truncator.js';

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function inputPreview(input: Record<string, unknown>): Record<string, unknown> {
  // This copy is only for the transcript. Never change the provider's invocation.
  const characters = Array.from(JSON.stringify(input));
  const smallFields = Object.entries(input)
    .filter(([, value]) => typeof value === 'string' && jsonBytes(value) <= 1024)
    .slice(0, 16);
  return {
    ...Object.fromEntries(smallFields),
    _disco_display_notice: '工具参数较长，聊天记录仅显示预览；实际调用使用完整参数。',
    _disco_input_preview: `${characters.slice(0, 3000).join('')}\n[… 参数预览已截取 …]\n${characters.slice(-1000).join('')}`,
  };
}

/** Bound the complete display payload, including duplicate inputs and envelope fields. */
export function prepareToolTranscript<T extends Partial<Message>>(
  message: T,
  budgetBytes = EXECUTOR_REQUEST_DATA_BUDGET_BYTES
): T {
  if (jsonBytes(message) <= budgetBytes || !Array.isArray(message.content)) return message;
  if (!message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')) {
    return message;
  }

  const prepared = { ...message, content: message.content.map((block) => ({ ...block })) };
  // Codex stores the canonical input in content. The compatibility list can
  // otherwise double a large skill-install payload before the tool even starts.
  if (message.tool_uses) {
    prepared.tool_uses = message.tool_uses.filter(
      (tool) =>
        tool.name === 'Task' ||
        !prepared.content.some(
          (block) =>
            block.type === 'tool_use' &&
            block.id === tool.id &&
            block.name === tool.name &&
            JSON.stringify(block.input) === JSON.stringify(tool.input)
        )
    );
    if (!prepared.tool_uses.length) delete prepared.tool_uses;
  }
  if (jsonBytes(prepared) <= budgetBytes) return prepared as T;

  const fitResults = () => {
    // The existing limiter only counted content, leaving no room for the rest
    // of messages.create/patch (including UTF-8 previews and tool references).
    const envelopeBytes = jsonBytes({ ...prepared, content: [] }) - 2;
    prepared.content = truncateContentIfNeeded(
      prepared.content,
      prepared.tool_uses,
      Math.max(0, budgetBytes - envelopeBytes)
    ).blocks as typeof prepared.content;
  };
  // Results alone cannot shrink a large input or an attached diff. Only the
  // display copy is reduced; execution and the provider transcript stay intact.
  for (const block of prepared.content) {
    if (
      block.type === 'tool_use' &&
      block.input &&
      typeof block.input === 'object' &&
      !Array.isArray(block.input) &&
      jsonBytes(block.input) > budgetBytes / 2
    ) {
      block.input = inputPreview(block.input as Record<string, unknown>);
    }
    if (block.type === 'tool_result' && block.diff && jsonBytes(block.diff) > budgetBytes / 4) {
      delete block.diff;
      const notice = { type: 'text', text: '差异内容较长，聊天记录已省略差异预览。' };
      block.content = Array.isArray(block.content)
        ? [...block.content, notice]
        : `${String(block.content ?? '')}\n${notice.text}`;
    }
  }
  prepared.tool_uses = prepared.tool_uses?.map((tool) => ({
    ...tool,
    input: jsonBytes(tool.input) > budgetBytes / 2 ? inputPreview(tool.input) : tool.input,
  }));
  fitResults();
  // The final transport guard remains authoritative for malformed or unrelated
  // oversized fields; do not silently truncate user prompts or assistant prose.
  return prepared as T;
}
