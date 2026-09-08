/**
 * Auto-title heuristic — derives a short session title from a user's first
 * prompt, with no LLM call.
 *
 * Used by the daemon when a task is created, with a completion-time fallback
 * when the session still has no explicit title: cheap, synchronous, and
 * tool-agnostic (works the same for every agentic tool, since it only reads
 * the prompt text already stored on the task — see `Task.full_prompt`).
 */

import { UPLOAD_ATTACHMENT_HEADING } from '../types/upload';

const MAX_TITLE_LENGTH = 42;

export function extractTitlePromptText(prompt: string): string {
  const lines = prompt.replace(/\r\n/g, '\n').split('\n');
  const visible: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const isAttachmentHeading = lines[index].trim() === UPLOAD_ATTACHMENT_HEADING;
    if (!isAttachmentHeading) {
      visible.push(lines[index]);
      continue;
    }

    let cursor = index + 1;
    let removed = 0;
    while (cursor < lines.length) {
      const line = lines[cursor].trim();
      const isAttachment =
        /^- \[.+\]\(https:\/\/disco\.live\/_uploads\/upl_[^)]+\) \([^)]+\)$/.test(line);
      if (!isAttachment) break;
      removed += 1;
      cursor += 1;
    }

    if (removed === 0) {
      visible.push(lines[index]);
      continue;
    }
    index = cursor - 1;
  }

  return visible.join('\n');
}

export function deriveTitleFromPrompt(prompt: string): string {
  // The canonical attachment block leads ordinary prompts and follows slash
  // commands; title only the user's text, or skip attachment-only prompts.
  const promptText = extractTitlePromptText(prompt);
  const collapsed = promptText
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:能不能帮我|可以帮我|请帮我|麻烦|帮我|请)\s*/u, '');
  if (!collapsed) return '';

  const firstSentence = collapsed.match(/^(.{6,42}?)[。！？!?](?:\s|$)/u)?.[1]?.trim();
  const candidate = firstSentence || collapsed;
  const characters = Array.from(candidate);
  if (characters.length <= MAX_TITLE_LENGTH) return candidate;

  const truncated = characters.slice(0, MAX_TITLE_LENGTH).join('');
  const lastSpace = truncated.lastIndexOf(' ');
  // Only break on a word boundary if it doesn't throw away most of the
  // budget (e.g. one very long leading word) — otherwise just hard-cut.
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.4 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}
