/**
 * Static Disco System Prompt Loader
 *
 * Used by SDK handlers to append the same Agent orientation text. Runtime
 * identity and working-directory values are supplied by the execution payload,
 * not fetched through a user-visible MCP operation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { renderTemplate } from './handlebars-helpers';

/**
 * Load Disco system prompt template from disk
 */
export async function loadDiscoSystemPromptTemplate(): Promise<string> {
  const templatePath = path.join(__dirname, 'disco-system-prompt.md');
  return await fs.readFile(templatePath, 'utf-8');
}

/**
 * Render the static Disco system prompt.
 *
 * This intentionally does not accept session or workspace dependencies. The
 * provider-specific runtime layer appends the authenticated execution boundary
 * and cached Agent snapshot separately.
 *
 * The rendered prompt is static for the life of the process, so the disk read
 * and render happen once and the result is shared by every tool and turn.
 */
let cachedPrompt: Promise<string> | undefined;

export function renderDiscoSystemPrompt(): Promise<string> {
  cachedPrompt ??= loadDiscoSystemPromptTemplate()
    .then((template) => renderTemplate(template, {}))
    .catch((error) => {
      cachedPrompt = undefined;
      throw error;
    });
  return cachedPrompt;
}
