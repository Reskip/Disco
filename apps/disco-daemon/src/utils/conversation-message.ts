import type { ContentBlock, Message } from '@disco/core/types';

// These values label a collapsed action. Its complete input/output remains in
// the stored Message and is fetched through the ordinary authorized get API.
const LABEL_FIELDS = [
  'title',
  'description',
  'file_path',
  'path',
  'pattern',
  'query',
  'command',
  'action',
  'tool_name',
  'domain',
  'url',
  'skill',
  'name',
  'prompt',
];

function labelInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const label: Record<string, unknown> = {};
  for (const key of LABEL_FIELDS) {
    const field = input[key];
    if (typeof field === 'string') label[key] = field.slice(0, 512);
    else if (key === 'command' && Array.isArray(field)) {
      label[key] = field
        .filter((item) => typeof item === 'string')
        .join(' ')
        .slice(0, 512);
    }
  }
  return label;
}

/** A display projection only: never persist it or use it for executor history. */
export function conversationMessage(message: Message): Message {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.map((block, block_index): ContentBlock => {
    const deferred = { message_id: message.message_id, block_index };
    if (block.type === 'tool_use' && block.name !== 'TodoWrite') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: labelInput(block.input),
        deferred,
      };
    }
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        is_error: block.is_error,
        content: '',
        deferred,
      };
    }
    // Text, attachments, questions, thinking, status and the live plan retain
    // their full content and original chronological positions.
    return block;
  });
  return {
    ...message,
    content,
    tool_uses: message.tool_uses?.map((tool) =>
      tool.name === 'TodoWrite' ? tool : { ...tool, input: labelInput(tool.input) }
    ),
  };
}
