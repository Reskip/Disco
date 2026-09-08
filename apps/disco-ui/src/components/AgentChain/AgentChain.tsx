/**
 * AgentChain - Collapsible visualization of agent reasoning and actions
 *
 * Groups sequential assistant messages containing:
 * - Internal thoughts (muted text blocks meant for agent reasoning)
 * - Tool uses (with results)
 *
 * Displays as:
 * - Collapsed (default): Summary with thought icon, counts, and stats
 * - Expanded: ToolBlock items showing sequential thoughts and tool uses
 *
 * Note: Regular assistant responses (text meant for user) are shown
 * as green message bubbles, NOT in AgentChain.
 */

import { BulbOutlined, CheckCircleOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import type { ContentBlock as CoreContentBlock, DiffEnrichment, Message } from '@disco-live/client';
import { Spin, Typography, theme } from 'antd';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { CollapsibleText } from '../CollapsibleText';
import {
  deriveToolStatus,
  IMPLICIT_RESULT_TOOLS,
  shouldExpandToolByDefault,
  ToolBlock,
} from '../ToolBlock';
import { ToolUseRenderer } from '../ToolUseRenderer';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | CoreContentBlock[];
  is_error?: boolean;
  diff?: DiffEnrichment;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface AgentChainProps {
  /**
   * Messages containing thoughts and/or tool uses
   */
  messages: Message[];
  /** Whether the parent task is still running (controls spinner vs stale for pending tools) */
  isTaskRunning?: boolean;
  /** Whether this is the latest (most recent) agent chain block — used for pending/stale status detection */
  isLatest?: boolean;
}

interface ChainItem {
  type: 'thought' | 'tool';
  content: string | { toolUse: ToolUseBlock; toolResult?: ToolResultBlock };
  message: Message;
}

const ACTIVITY_SUMMARY_LIMIT = 56;

function compactActivityText(value: string, limit = ACTIVITY_SUMMARY_LIMIT): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(compact);
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : compact;
}

function isWebSearchTool(toolUse: ToolUseBlock): boolean {
  const normalizedName = toolUse.name.toLowerCase();
  return normalizedName.includes('web_search') || toolUse.name === 'WebSearch';
}

interface SearchActivitySummary {
  query: string;
  sourceLabel: string;
}

function summarizeSearchActivity(toolUse: ToolUseBlock): SearchActivitySummary {
  const rawQuery = typeof toolUse.input.query === 'string' ? toolUse.input.query : '';
  const sources = new Set<string>();

  for (const match of rawQuery.matchAll(/\bsite:([^\s"')]+)/giu)) {
    const host = match[1]
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '');
    if (host) sources.add(host);
  }
  for (const match of rawQuery.matchAll(/https?:\/\/([^/\s"')]+)/giu)) {
    const host = match[1].replace(/^www\./i, '');
    if (host) sources.add(host);
  }

  const queryWithoutSites = rawQuery
    .replace(/\bsite:[^\s"')]+/giu, ' ')
    .replace(/https?:\/\/[^\s"')]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    query: compactActivityText(queryWithoutSites || rawQuery || '检索相关资料', 72),
    sourceLabel: sources.size > 0 ? Array.from(sources).slice(0, 2).join('、') : '全网',
  };
}

function bashCommandText(input: Record<string, unknown>): string {
  const command = input.command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return typeof command === 'string' ? command : '';
}

function basenameFromCommandPath(value: string): string | undefined {
  const path = value.trim().replace(/^['"]|['"]$/g, '');
  const basename = path.split(/[\\/]/).at(-1)?.trim();
  return basename && basename.length <= 48 ? basename : undefined;
}

function commandPathAfter(command: string, expression: RegExp): string | undefined {
  const match = command.match(expression);
  return match?.[1] ? basenameFromCommandPath(match[1]) : undefined;
}

function decodeSearchQueryFromCommand(command: string): string | undefined {
  const match = command.match(/[?&]q=([^"'&\s]+)/iu);
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
    return decoded.match(/^["']([^"']+)["']/u)?.[1] ?? decoded.replace(/^['"]|['"]$/g, '');
  } catch {
    return match[1].replace(/\+/g, ' ').trim();
  }
}

function packageNamesFromInstallCommand(command: string): string | undefined {
  const match = command.match(
    /(?:python(?:3)?|py(?:\.exe)?)\s+-m\s+pip\s+install\s+(.+?)(?:\s+(?:--?[\w-]+|\||;|$)|$)/iu
  );
  if (!match?.[1]) return undefined;
  const packages = match[1]
    .split(/\s+/u)
    .filter(value => value && !value.startsWith('-'))
    .slice(0, 3)
    .join('、');
  return packages ? compactActivityText(packages, 36) : undefined;
}

function waitDurationLabel(command: string): string | undefined {
  const seconds = command.match(/\bstart-sleep\s+(?:-seconds\s+)?([0-9]+(?:\.[0-9]+)?)/iu)?.[1];
  if (seconds) return `${Number(seconds)} 秒`;
  const milliseconds = command.match(/\bstart-sleep\s+-milliseconds\s+([0-9]+)/iu)?.[1];
  if (milliseconds) return `${Number(milliseconds) / 1000} 秒`;
  const timeoutSeconds = command.match(/\btimeout(?:\.exe)?\s+(?:\/t\s+)?([0-9]+)/iu)?.[1];
  if (timeoutSeconds) return `${Number(timeoutSeconds)} 秒`;
  const sleepSeconds = command.match(/(?:^|[;&|]\s*)sleep\s+([0-9]+(?:\.[0-9]+)?)/iu)?.[1];
  return sleepSeconds ? `${Number(sleepSeconds)} 秒` : undefined;
}

function isPredominantlyWaitCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  if (!/\b(start-sleep|timeout(?:\.exe)?|sleep|wait-process|wait-job)\b/u.test(normalized)) {
    return false;
  }

  // A retry, download or analysis script may contain a short sleep as a minor
  // implementation detail. That does not make the user-visible action a wait.
  if (
    /\b(curl(?:\.exe)?|invoke-webrequest|wget|requests\.(?:get|post)|httpx|urllib|fetch\s*\(|fitz|pymupdf|image\.open|opencv|cv2|copy-item|move-item|remove-item|new-item|set-content|add-content|out-file|convertto-json|export-csv)\b/u.test(
      normalized
    )
  ) {
    return false;
  }

  const shellBody = normalized
    .replace(/^\s*["']?[^"']*(?:powershell|pwsh)(?:\.exe)?["']?\s+(?:-[\w-]+\s+)*-command\s+/u, '')
    .replace(/^["']|["']$/gu, '')
    .trim();
  if (
    /^(?:start-sleep(?:\s+-\w+)?\s+[\d.]+|timeout(?:\.exe)?\s+(?:\/t\s+)?\d+|sleep\s+[\d.]+|wait-(?:process|job)(?:\s+.+)?)[;\s]*$/u.test(
      shellBody
    )
  ) {
    return true;
  }

  const isStatusPoll =
    /\b(get-process|get-ciminstance|tasklist|wait-process|get-job|receive-job|wait-job)\b/u.test(
      normalized
    ) || /\b(?:test-path|get-item)\b.*\b(?:task|job|pid|lock)\b/u.test(normalized);
  return isStatusPoll && shellBody.length <= 520;
}

function runtimeFallbackLabel(command: string): string {
  if (/\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/iu.test(command)) {
    if (/\b(?:set-content|add-content|out-file)\b/iu.test(command)) {
      const target = commandPathAfter(
        command,
        /(?:set-content|add-content|out-file)\s+(?:-literalpath\s+|-filepath\s+)?["']([^"']+)["']/iu
      );
      return target ? `写入 ${target}` : '写入工作区文件';
    }
    if (/\b(?:convertto-json|export-csv|convertto-csv)\b/iu.test(command)) {
      return '整理并导出数据';
    }
    if (
      /\b(?:foreach(?:-object)?|where-object|select-object|sort-object|group-object)\b/iu.test(
        command
      )
    ) {
      return '筛选并整理数据';
    }
    const cmdlet = command.match(
      /\b([a-z]+-(?:item|content|object|process|service|file|path|location|variable|property))\b/iu
    )?.[1];
    return cmdlet ? `执行 ${cmdlet}` : '处理脚本数据';
  }
  if (/\b(?:python(?:3)?|py(?:\.exe)?)\b/iu.test(command)) {
    if (/\b(?:pandas|csv|json|dataframe|openpyxl)\b/iu.test(command)) return '整理数据文件';
    if (/\b(?:write_text|write_bytes|to_csv|to_excel|open\s*\([^)]*["']w)/iu.test(command)) {
      return '生成工作区文件';
    }
    return '处理 Python 数据';
  }
  if (/\b(?:node(?:\.exe)?|tsx?|bun|deno)\b/iu.test(command)) return '处理脚本数据';
  return '运行工作区命令';
}

function bashActionLabel(input: Record<string, unknown>): string {
  const originalCommand = bashCommandText(input);
  const command = originalCommand.toLowerCase();
  if (!command) return '运行工作区命令';

  // Interpret the operation before its shell wrapper. Codex commonly emits
  // powershell.exe -Command or an inline Python script; exposing only the
  // runtime name makes every row read as the same meaningless action.
  const searchQuery = decodeSearchQueryFromCommand(originalCommand);
  if (searchQuery && /(?:bing|google|sogou|so)\.(?:com|cn)|\/search\?/iu.test(command)) {
    return `检索“${compactActivityText(searchQuery, 28)}”`;
  }
  const packageNames = packageNamesFromInstallCommand(originalCommand);
  if (packageNames) return `安装 ${packageNames}`;
  const waitsBeforeNextAction = isPredominantlyWaitCommand(originalCommand);
  const waitDuration = waitDurationLabel(originalCommand);
  if (
    waitsBeforeNextAction &&
    /\b(get-process|get-ciminstance|tasklist|wait-process)\b/.test(command)
  ) {
    return waitDuration ? `等待 ${waitDuration}后检查运行进程` : '等待后检查运行进程';
  }
  if (
    waitsBeforeNextAction &&
    /\b(?:get-job|receive-job|wait-job)\b|\b(?:test-path|get-item)\b.*\b(?:task|job|pid|lock)\b/iu.test(
      command
    )
  ) {
    return waitDuration ? `等待 ${waitDuration}后检查运行状态` : '等待后检查运行状态';
  }
  if (
    /\[environment\]::getenvironmentvariable|\bget-childitem\s+env:|\bget-item\s+env:/u.test(
      command
    )
  ) {
    return '检查运行环境配置';
  }
  if (/\b(fitz|pymupdf|pdftotext)\b/.test(command) && /\b(get_text|extract|text)\b/.test(command)) {
    return '提取 PDF 文本';
  }
  if (
    /\b(fitz|pymupdf|pdftoppm|mutool|magick)\b/.test(command) &&
    /\b(render|pixmap|thumbnail|contact.?sheet|preview|save)\b/.test(command)
  ) {
    return '生成 PDF 预览';
  }
  if (/\b(pil|pillow|image\.open|opencv|cv2)\b/.test(command)) return '分析图片内容';

  if (
    /\bget-command\b/.test(command) &&
    /\b(pdftotext|pdfinfo|pdftoppm|mutool|qpdf|gswin64c|magick)\b/.test(command)
  ) {
    return '检查 PDF 解析工具';
  }
  if (/\bget-item\b/.test(command) && /\.pdf\b/.test(command)) return '检查上传的 PDF 文件';
  if (/\bget-command\b/.test(command)) return '检查本机可用工具';
  if (/\b(get-process|get-ciminstance|tasklist)\b/.test(command)) return '检查运行进程';
  if (/\b(git\s+(status|diff|log|show)|git\.exe\s+(status|diff|log|show))\b/.test(command))
    return '检查代码变更';
  if (
    /\b(vitest|jest|pytest|cargo\s+test|go\s+test|pnpm(?:\s+--?\S+)*\s+test|npm\s+test)\b/.test(
      command
    )
  )
    return '运行测试';
  if (/\b(tsc|typecheck|check-types)\b/.test(command)) return '检查类型';
  if (/\b(eslint|biome|prettier|lint)\b/.test(command)) return '检查代码质量';
  if (/\b(rg|grep|findstr|select-string)\b/.test(command)) {
    const pattern = originalCommand.match(/\brg(?:\.exe)?(?:\s+-\S+)*\s+["']([^"']+)["']/iu)?.[1];
    return pattern ? `查找“${compactActivityText(pattern, 24)}”` : '查找代码和文本';
  }
  if (/\b(get-content|cat|type)\b/.test(command)) {
    const filename = commandPathAfter(
      originalCommand,
      /(?:get-content\s+(?:-literalpath\s+)?|\bcat\s+|\btype\s+)["']([^"']+)["']/iu
    );
    return filename ? `读取 ${filename}` : '读取文件内容';
  }
  if (/\b(get-childitem|dir|ls)\b/.test(command)) return '浏览项目文件';
  if (/\b(pnpm|npm|yarn)\b.*\b(install|build)\b/.test(command)) return '构建项目';
  if (/\b(curl|invoke-webrequest|wget)\b/.test(command)) {
    if (searchQuery) return `检索“${compactActivityText(searchQuery, 28)}”`;
    const host = originalCommand.match(/https?:\/\/([^/\s"']+)/iu)?.[1]?.replace(/^www\./i, '');
    return host ? `访问 ${host}` : '请求网络资源';
  }
  if (/\b(requests\.get|urllib|httpx)|fetch\s*\(/.test(command)) {
    const host = originalCommand.match(/https?:\/\/([^/\s"']+)/iu)?.[1]?.replace(/^www\./i, '');
    return host ? `访问 ${host}` : '检索网络资料';
  }
  if (/\b(sqlite3|psql)\b/.test(command)) return '查询项目数据';
  if (/\b(copy-item|move-item|cp|mv)\b/.test(command)) return '整理项目文件';
  if (/\b(remove-item|\brm\b|\bdel\b)\b/.test(command)) return '清理项目文件';
  if (/\b(new-item|mkdir|md)\b/.test(command)) return '创建项目目录';
  if (/\bget-item\b/.test(command)) return '检查文件信息';
  if (waitsBeforeNextAction) {
    return waitDuration ? `等待 ${waitDuration}后继续` : '等待后继续';
  }
  return runtimeFallbackLabel(originalCommand);
}

function explicitToolAction(input: Record<string, unknown>): string | undefined {
  const raw =
    typeof input.title === 'string'
      ? input.title
      : typeof input.description === 'string'
        ? input.description
        : '';
  const compact = compactActivityText(raw, 42)
    .replace(/^(?:正在|已经|已)(?:执行|运行|处理|使用)?\s*/u, '')
    .trim();
  if (
    compact.length < 4 ||
    /^(?:js|bash|shell|命令|项目命令|执行项目命令|短暂等待|等待|等待后继续|运行(?:\s*(?:powershell|python|node\.js))?(?:\s*(?:命令|脚本))?)$/iu.test(
      compact
    )
  ) {
    return undefined;
  }
  return compact;
}

function contextualActionBefore(items: ChainItem[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor -= 1) {
    const item = items[cursor];
    if (item.type === 'tool') break;
    const firstSentence = compactActivityText(item.content as string, 56).split(/[。！？]/u)[0];
    const action = firstSentence
      .replace(/^(?:收到|好的|明白)[，,\s]*/u, '')
      .replace(/^我(?:先|会|将|继续|准备|需要)?\s*/u, '')
      .replace(/^(?:接下来|现在|随后|然后|先|继续)[，,\s]*/u, '')
      .trim();
    if (
      /^(?:按要求)?(?:只)?(?:执行|运行)(?:这一条|一次)?\s*(?:powershell|python|node\.?js)?\s*(?:命令|脚本)$/iu.test(
        action
      )
    ) {
      continue;
    }
    if (action.length >= 4 && action.length <= 42) return action;
  }
  return undefined;
}

function toolActionLabel(toolUse: ToolUseBlock, contextualAction?: string): string {
  const normalizedName = toolUse.name.toLowerCase();
  const explicitAction = explicitToolAction(toolUse.input);
  if (explicitAction) return explicitAction;
  if (isWebSearchTool(toolUse)) return '检索资料';
  if (normalizedName.includes('web_fetch') || toolUse.name === 'WebFetch') return '读取网页';
  if (
    normalizedName === 'js' ||
    normalizedName.endsWith('.js') ||
    normalizedName.includes('node_repl') ||
    normalizedName.includes('browser')
  ) {
    return contextualAction ?? '操作浏览器与本机工具';
  }

  switch (toolUse.name) {
    case 'Bash': {
      const action = bashActionLabel(toolUse.input);
      const genericRuntimeAction = /^(?:处理脚本数据|处理 Python 数据|运行工作区命令)$/u.test(
        action
      );
      return genericRuntimeAction && contextualAction ? contextualAction : action;
    }
    case 'Read':
      return '读取文件';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'edit_files':
      return '修改文件';
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
      return '查找内容';
    case 'TodoWrite':
      return '更新任务计划';
    case 'Task':
    case 'Agent':
      return '协调智能体';
    case 'Skill':
    case 'SlashCommand':
      return '加载工作能力';
    default:
      return contextualAction ?? getToolDisplayName(toolUse.name, toolUse.input);
  }
}

function toolActivityLabel(
  toolUse: ToolUseBlock,
  status: 'success' | 'error' | 'pending' | 'stale',
  contextualAction?: string
): string {
  if (toolUse.name.toLowerCase() === 'viewimage') {
    if (status === 'pending') return '正在查看图片';
    if (status === 'error') return '查看图片失败';
    return '查看了图片';
  }
  if (isWebSearchTool(toolUse)) {
    const { sourceLabel } = summarizeSearchActivity(toolUse);
    if (status === 'pending') return `正在检索 ${sourceLabel}`;
    return `检索 ${sourceLabel}`;
  }

  const action = toolActionLabel(toolUse, contextualAction);
  if (status === 'pending') return `正在${action}`;
  return action;
}

function thinkingAfterToolLabel(toolUse: ToolUseBlock): string {
  const normalizedName = toolUse.name.toLowerCase();
  if (isWebSearchTool(toolUse) || normalizedName.includes('web_fetch')) {
    return '正在整理检索结果';
  }
  if (toolUse.name === 'Read' || toolUse.name === 'Grep' || toolUse.name === 'Glob') {
    return '正在分析已读取的内容';
  }
  if (toolUse.name === 'Bash') return '正在检查执行结果';
  if (toolUse.name === 'TodoWrite') return '正在规划下一步';
  return '正在思考下一步';
}

export const AgentChain = React.memo<AgentChainProps>(
  ({ messages, isTaskRunning = false, isLatest }) => {
    const { token } = theme.useToken();
    const [expanded, setExpanded] = useState(false);
    const chainRef = useRef<HTMLDivElement | null>(null);
    const anchorFrameRef = useRef<number | null>(null);

    useEffect(
      () => () => {
        if (anchorFrameRef.current !== null) cancelAnimationFrame(anchorFrameRef.current);
      },
      []
    );

    const toggleExpandedWithoutLayoutJump = () => {
      const chain = chainRef.current;
      const scrollContainer = chain?.closest<HTMLElement>(
        '[data-testid="conversation-scroll-container"]'
      );
      const anchoredBottom = chain?.getBoundingClientRect().bottom;

      setExpanded(value => !value);
      if (!chain || !scrollContainer || anchoredBottom === undefined) return;

      if (anchorFrameRef.current !== null) cancelAnimationFrame(anchorFrameRef.current);
      const startedAt = performance.now();
      const preserveFollowingContentPosition = () => {
        const delta = chain.getBoundingClientRect().bottom - anchoredBottom;
        if (Math.abs(delta) > 0.25) scrollContainer.scrollTop += delta;
        if (performance.now() - startedAt < 190) {
          anchorFrameRef.current = requestAnimationFrame(preserveFollowingContentPosition);
        } else {
          anchorFrameRef.current = null;
        }
      };
      anchorFrameRef.current = requestAnimationFrame(preserveFollowingContentPosition);
    };

    // Extract chain items (thoughts and tools) from messages
    const chainItems = useMemo(() => {
      // Return early if no messages
      if (!messages || messages.length === 0) {
        return [];
      }

      const items: ChainItem[] = [];

      // First pass: collect ALL tool results from ALL messages (including user messages)
      const globalToolResultMap = new Map<string, ToolResultBlock>();
      for (const message of messages) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              const toolResult = block as unknown as ToolResultBlock;
              globalToolResultMap.set(toolResult.tool_use_id, toolResult);
            }
          }
        }
      }

      // Second pass: process each message
      for (const message of messages) {
        if (typeof message.content === 'string') {
          // Simple text thought
          if (message.content.trim()) {
            items.push({
              type: 'thought',
              content: message.content,
              message,
            });
          }
          continue;
        }

        if (!Array.isArray(message.content)) continue;

        // Tool-result messages are already matched back to their tool uses by
        // globalToolResultMap. Rendering them again as thoughts duplicates the
        // entire output and is the main cause of overlong activity timelines.
        if (message.role === 'user') {
          const toolResults = message.content.filter(b => b.type === 'tool_result');
          if (toolResults.length > 0) {
            continue;
          }
        }

        const toolUseMap = new Map<string, ToolUseBlock>();
        const textBlocksBeforeTools: string[] = [];
        const textBlocksAfterTools: string[] = [];

        let hasSeenTool = false;

        // Collect blocks from this message
        for (const block of message.content) {
          if (block.type === 'text') {
            const text = (block as unknown as TextBlock).text.trim();
            if (text) {
              if (hasSeenTool) {
                textBlocksAfterTools.push(text);
              } else {
                textBlocksBeforeTools.push(text);
              }
            }
          } else if (block.type === 'tool_use') {
            const toolUse = block as unknown as ToolUseBlock;
            hasSeenTool = true;
            // TodoWrite is task chrome, not a chronological action. Its live
            // state is rendered once in the floating plan control above the
            // composer; repeating it here creates the misleading
            // "更新任务计划" activity row.
            if (toolUse.name !== 'TodoWrite') {
              toolUseMap.set(toolUse.id, toolUse);
            }
          }
          // Skip tool_result here - we collected them globally above
        }

        // Add thoughts (text blocks BEFORE tools)
        for (const text of textBlocksBeforeTools) {
          items.push({
            type: 'thought',
            content: text,
            message,
          });
        }

        // Add tool uses with globally matched results
        for (const [id, toolUse] of toolUseMap.entries()) {
          items.push({
            type: 'tool',
            content: {
              toolUse,
              toolResult: globalToolResultMap.get(id), // Look up from global map
            },
            message,
          });
        }

        // Add text blocks AFTER tools as thoughts (will be styled differently below)
        for (const text of textBlocksAfterTools) {
          items.push({
            type: 'thought',
            content: text,
            message,
          });
        }
      }

      return items;
    }, [messages]);

    // Generate smart description for tool
    const getToolDescription = (toolUse: ToolUseBlock): string | null => {
      const { name, input } = toolUse;

      if (typeof input.description === 'string') {
        return input.description;
      }

      switch (name) {
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'NotebookEdit':
          if (input.file_path) {
            const path = String(input.file_path);
            return path
              .replace(/^\/Users\/[^/]+\/code\/[^/]+\//, '')
              .replace(/^\/Users\/[^/]+\//, '~/');
          }
          return null;

        case 'Grep':
          return input.pattern ? String(input.pattern) : null;

        case 'Glob':
          return input.pattern ? String(input.pattern) : null;

        case 'ToolSearch':
          return input.query ? String(input.query) : null;

        case 'WebSearch':
        case 'web_search':
          return summarizeSearchActivity(toolUse).query;

        case 'WebFetch':
          return input.url ? String(input.url) : null;

        case 'Agent':
          return input.description ? String(input.description) : null;

        case 'Skill':
        case 'SlashCommand':
          return input.skill ? String(input.skill) : input.name ? String(input.name) : null;

        case 'Task':
          if (input.prompt) {
            const firstLine = String(input.prompt).trim().split('\n')[0];
            return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
          }
          return null;

        case 'TodoWrite': {
          const todos = Array.isArray(input.todos) ? input.todos : [];
          if (todos.length === 0) return null;
          const done = todos.filter((t: { status?: string }) => t.status === 'completed').length;
          const inProg = todos.filter(
            (t: { status?: string }) => t.status === 'in_progress'
          ).length;
          const parts = [`${done}/${todos.length} 已完成`];
          if (inProg > 0) parts.push(`${inProg} 进行中`);
          return parts.join(', ');
        }

        case 'edit_files': {
          const changes = Array.isArray(input.changes) ? input.changes : [];
          if (changes.length === 0) return null;
          if (changes.length === 1) {
            const c = changes[0] as { path?: string; kind?: string };
            const shortPath = c.path
              ? String(c.path)
                  .replace(/^\/Users\/[^/]+\/code\/[^/]+\//, '')
                  .replace(/^\/Users\/[^/]+\//, '~/')
              : '';
            return `${c.kind || '修改'} ${shortPath}`;
          }
          return `${changes.length} 个文件`;
        }

        default:
          return null;
      }
    };

    // Precompute index of the last tool item that has a result.
    // Tools after this index have no subsequent completed tool, so they
    // are potentially still running (handles concurrent tool calls).
    const lastResultToolIndex = useMemo(() => {
      for (let i = chainItems.length - 1; i >= 0; i--) {
        if (chainItems[i].type === 'tool') {
          const { toolResult } = chainItems[i].content as {
            toolResult?: ToolResultBlock;
          };
          if (toolResult) return i;
        }
      }
      return -1;
    }, [chainItems]);

    const statusForTool = (
      item: ChainItem,
      index: number
    ): 'success' | 'error' | 'pending' | 'stale' => {
      const { toolUse, toolResult } = item.content as {
        toolUse: ToolUseBlock;
        toolResult?: ToolResultBlock;
      };
      const hasImplicitResult = IMPLICIT_RESULT_TOOLS.has(toolUse.name);
      return deriveToolStatus({
        hasResult: !!toolResult || hasImplicitResult,
        isError: !!toolResult?.is_error,
        isPotentiallyRunning: index > lastResultToolIndex && isLatest !== false,
        isTaskRunning,
      });
    };

    // Build tool block items for rendering
    const renderChainItem = (item: ChainItem, index: number) => {
      if (item.type === 'thought') {
        const thoughtContent = item.content as string;
        const oneLine = thoughtContent.replace(/\s+/g, ' ').trim();

        return (
          <ToolBlock
            key={`thought-${index}`}
            icon={<BulbOutlined style={{ fontSize: 14 }} />}
            showIcon={false}
            name="思考"
            description={oneLine || undefined}
            status="success"
          >
            {thoughtContent.trim() && (
              <CollapsibleText
                maxLines={8}
                preserveWhitespace
                style={{
                  fontSize: token.fontSizeSM,
                  margin: 0,
                  color: token.colorTextTertiary,
                }}
              >
                {thoughtContent}
              </CollapsibleText>
            )}
          </ToolBlock>
        );
      }

      // Tool use
      const { toolUse, toolResult } = item.content as {
        toolUse: ToolUseBlock;
        toolResult?: ToolResultBlock;
      };
      const status = statusForTool(item, index);
      const contextualAction = contextualActionBefore(chainItems, index);
      const displayName = toolActivityLabel(toolUse, status, contextualAction);

      // Match Codex's image-view treatment when the chain contains only this
      // visual action: the outer "查看了图片" row is already the header, so its
      // expanded body should be the thumbnail itself rather than a duplicate
      // nested header with the same label.
      if (chainItems.length === 1 && toolUse.name.toLowerCase() === 'viewimage') {
        return (
          <div key={toolUse.id} className="disco-agent-chain-image-preview">
            <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} compact />
          </div>
        );
      }

      // Description — key context for the tool call
      let description = getToolDescription(toolUse);
      let descriptionNode: React.ReactNode | undefined;

      if (toolUse.name === 'Bash') {
        // Keep raw shell invocations inside the individually expandable tool
        // details. The timeline should describe intent, not expose a long
        // PowerShell executable path as the primary activity label.
        description = null;
      } else if ((toolUse.name === 'Grep' || toolUse.name === 'Glob') && toolUse.input.pattern) {
        descriptionNode = (
          <Typography.Text code style={{ fontSize: token.fontSizeSM - 1 }}>
            {String(toolUse.input.pattern)}
          </Typography.Text>
        );
        description = null;
      }

      const searchSummary = isWebSearchTool(toolUse) ? summarizeSearchActivity(toolUse) : undefined;
      const todos =
        toolUse.name === 'TodoWrite' && Array.isArray(toolUse.input.todos)
          ? (
              toolUse.input.todos as Array<{
                content?: unknown;
                activeForm?: unknown;
                status?: unknown;
              }>
            ).filter(todo => typeof todo.content === 'string')
          : [];
      const currentTodoIndex = todos.findIndex(todo => todo.status === 'in_progress');
      const firstPendingTodoIndex = todos.findIndex(todo => todo.status !== 'completed');
      const allTodosComplete = todos.length > 0 && firstPendingTodoIndex === -1;
      const visibleTodoIndex =
        currentTodoIndex >= 0
          ? currentTodoIndex
          : allTodosComplete
            ? todos.length - 1
            : Math.max(0, firstPendingTodoIndex);

      return (
        <ToolBlock
          key={toolUse.id}
          icon={null}
          showIcon={false}
          name={displayName}
          description={searchSummary?.query ?? description ?? undefined}
          descriptionNode={descriptionNode}
          status={status}
          expandedByDefault={shouldExpandToolByDefault(toolUse.name)}
        >
          {todos.length > 0 ? (
            <div className="disco-inline-task-plan">
              <div className="disco-inline-task-plan-progress">
                {allTodosComplete
                  ? `${todos.length}/${todos.length} 步已完成`
                  : `第 ${visibleTodoIndex + 1}/${todos.length} 步`}
              </div>
              <ol>
                {todos.map(todo => (
                  <li
                    key={`${toolUse.id}-todo-${String(todo.content)}-${String(todo.status)}`}
                    className={
                      todo.status === 'in_progress'
                        ? 'is-current'
                        : todo.status === 'completed'
                          ? 'is-complete'
                          : undefined
                    }
                  >
                    {String(
                      todo.status === 'in_progress' && typeof todo.activeForm === 'string'
                        ? todo.activeForm
                        : todo.content
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : searchSummary ? (
            <div className="disco-tool-io">
              <div className="disco-tool-io-section">
                <Typography.Text type="secondary">输入</Typography.Text>
                <Typography.Text>{searchSummary.query}</Typography.Text>
              </div>
              <div className={`disco-tool-io-section${status === 'error' ? ' is-error' : ''}`}>
                <Typography.Text type="secondary">输出</Typography.Text>
                <Typography.Text>
                  {status === 'pending'
                    ? `正在从${searchSummary.sourceLabel}检索资料`
                    : status === 'error'
                      ? `${searchSummary.sourceLabel}检索未完成`
                      : `完成${searchSummary.sourceLabel}检索`}
                </Typography.Text>
              </div>
            </div>
          ) : (
            <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} compact />
          )}
        </ToolBlock>
      );
    };

    const latestActivity = chainItems.at(-1);
    const latestIndex = chainItems.length - 1;
    const latestStatus =
      latestActivity?.type === 'tool'
        ? statusForTool(latestActivity, latestIndex)
        : isTaskRunning && isLatest !== false
          ? 'pending'
          : 'success';
    const waitingForNextAction =
      isTaskRunning &&
      isLatest !== false &&
      latestActivity?.type === 'tool' &&
      latestStatus !== 'pending';
    const betweenActionLabel =
      waitingForNextAction && latestActivity?.type === 'tool'
        ? thinkingAfterToolLabel((latestActivity.content as { toolUse: ToolUseBlock }).toolUse)
        : undefined;
    const summaryLabel = (() => {
      if (betweenActionLabel) return betweenActionLabel;
      if (!latestActivity) return '正在思考';
      if (latestActivity.type === 'tool') {
        const { toolUse } = latestActivity.content as { toolUse: ToolUseBlock };
        return toolActivityLabel(
          toolUse,
          latestStatus,
          contextualActionBefore(chainItems, latestIndex)
        );
      }
      const thought = compactActivityText(latestActivity.content as string, 48);
      return latestStatus === 'pending'
        ? thought
          ? `正在分析：${thought}`
          : '正在分析'
        : '分析与整理';
    })();
    const summaryIsRunning = latestStatus === 'pending' || waitingForNextAction;

    // A live executor can briefly have an empty message batch while it is
    // thinking or preparing the next response. Never leave a blank running
    // turn: retain an understated activity indicator until content arrives.
    if (chainItems.length === 0) {
      if (!isTaskRunning || isLatest === false) return null;
      return (
        <div className="disco-agent-chain">
          <div className="disco-agent-chain-summary" role="status" aria-label="正在思考">
            <Spin size="small" />
            <Typography.Text type="secondary">正在思考…</Typography.Text>
          </div>
        </div>
      );
    }

    return (
      <div ref={chainRef} className="disco-agent-chain">
        <button
          type="button"
          className="disco-agent-chain-summary"
          aria-expanded={expanded}
          onClick={toggleExpandedWithoutLayoutJump}
        >
          {expanded ? <DownOutlined aria-hidden /> : <RightOutlined aria-hidden />}
          {summaryIsRunning ? (
            <Spin size="small" />
          ) : (
            <CheckCircleOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
          )}
          <Typography.Text type="secondary">{summaryLabel}</Typography.Text>
        </button>

        <div
          className={`disco-agent-chain-collapse${expanded ? ' is-expanded' : ''}`}
          aria-hidden={!expanded}
        >
          <div className="disco-agent-chain-collapse-inner">
            <div className="disco-agent-chain-details">
              {chainItems.map(renderChainItem)}
              {waitingForNextAction && betweenActionLabel && (
                <ToolBlock
                  key="between-actions-thinking"
                  icon={null}
                  showIcon={false}
                  name={betweenActionLabel}
                  status="pending"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

AgentChain.displayName = 'AgentChain';
