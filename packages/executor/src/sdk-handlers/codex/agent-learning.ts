import { DISCO_MCP_METHOD_NAMES } from '@disco/core';
import type { AgentLearningStatus } from '@disco/core/agent-runtime';
import type { TokenUsage } from '../../types/token-usage.js';
import type { CodexStreamEvent } from './prompt-service.js';

export function buildAgentLearningInstruction(taskId?: string): string {
  return `## 主动学习

用户明确表达的稳定偏好、对你行为的纠正，以及已验证且未来会复用的事实，应在本轮通过 ${DISCO_MCP_METHOD_NAMES.agentMemorySave} 记录，不必等用户说“记住”。区分 user-explicit 与 agent-inference；推测必须保留不确定性，禁止把猜测写成事实。不要保存一次性进度、凭据或临时状态。纠正同一主题时先读取旧记录，保留仍有效的信息，再携带 expectedUpdatedAt 更新；用户停用的记录保持停用。

完成复杂任务、解决反复问题、验证了有用的排错方法或发现重复流程后，评估是否形成技能。当步骤可以重复使用、包含具体处理经验或容易踩的坑，且方法得到实际验证时，应主动调用 ${DISCO_MCP_METHOD_NAMES.skillsInstall} 保存或更新技能，不必等用户要求“生成技能”，也不必等第二次遇到。先查现有技能，优先完善已有技能；用户已停用的技能不要自动启用。generatedByAgent=true，默认仅当前智能体。技能应包含适用条件、步骤、验证办法、常见失败与边界。没有复用价值的普通问答、一次性流水账、私人事实和未经验证的方法不生成技能。

${taskId ? `本轮 taskId：${taskId}。有学习价值或复杂任务结束前，调用 ${DISCO_MCP_METHOD_NAMES.agentLearningReview} 的 complete，分别说明记忆与技能的评估结果；没有值得保存的内容也是有效结果。只有需要纠正原文或集中整理时才先 inspect，避免重复读取已经预加载的记忆。` : ''}
达到记忆整理条件时，读取 inspect 返回的最新原文，合并重复信息；冲突优先采用明确纠正和更新的已验证事实，无法判定时保留分歧及来源。摘要保留重要约束、适用范围、来源路径与更新时间；原文由系统保留。提交 consolidation 时必须使用当前 fingerprint 和全部 sourcePaths，过期则重新读取。

用户明确要求只读、不要记录/学习或暂停时，不做持久化操作。其他范围限制按原意遵守，例如“无需交付文件”只限制交付，不等于禁止总结当前智能体的技能。学习不得变成新的外部操作，不得为了凑数量制造记忆或技能，也不要在最终回答里重复复盘日志。`;
}

export function shouldSupplementAgentReview(
  prompt: string,
  toolNames: string[],
  status: AgentLearningStatus,
  taskId: string
): boolean {
  if (status.reviews.some((review) => review.taskId === taskId)) return false;
  if (
    /(只读|read[- ]only|不要.{0,12}(记录|保存|记住)|别.{0,8}(记录|保存|记住)|do not (remember|save))/iu.test(
      prompt
    )
  )
    return false;
  const workTools = toolNames.filter(
    (name) => !/(search_tools|get_tool_details|learning_review|TodoWrite)/u.test(name)
  );
  return (
    status.consolidationDue ||
    workTools.length >= 3 ||
    workTools.some((name) => /(agent_memory_save|skills_install)/u.test(name)) ||
    (workTools.length > 0 &&
      /(核验|校验|验证|修复|实现|流程|重复使用|validation|workflow)/iu.test(prompt)) ||
    /(记住|偏好|我喜欢|我习惯|以后|今后|不要再|排查|调试|反复|复用|remember|preference|from now on|debug)/iu.test(
      prompt
    ) ||
    prompt.length >= 600
  );
}

function combinedUsage(base: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const result: TokenUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
  ] as const) {
    if (base?.[key] !== undefined || next[key] !== undefined)
      result[key] = (base?.[key] ?? 0) + (next[key] ?? 0);
  }
  return result;
}

/** One bounded continuation, in the same task, so admission/stop/queue semantics stay intact. */
export async function* withAgentLearningReview(options: {
  prompt: string;
  taskId?: string;
  run: (prompt: string, signal?: AbortController) => AsyncGenerator<CodexStreamEvent>;
  loadStatus: () => Promise<AgentLearningStatus | null>;
  stopped: () => boolean;
  onReviewStart?: () => void;
  onReviewEnd?: () => void;
  wasReviewSteered?: () => boolean;
  abortController?: AbortController;
  timeoutMs?: number;
}): AsyncGenerator<CodexStreamEvent> {
  let stopped = false;
  let usage: TokenUsage | undefined;
  let threadId = '';
  const toolNames: string[] = [];
  for await (const event of options.run(options.prompt, options.abortController)) {
    if (event.type === 'stopped') stopped = true;
    if ('usage' in event && event.usage) usage = event.usage;
    if (event.threadId) threadId = event.threadId;
    if (event.type === 'tool_complete') {
      toolNames.push(
        String(
          event.toolUse.input.tool_name ??
            event.toolUse.input.name ??
            event.toolUse.input.method ??
            event.toolUse.name
        )
      );
    }
    yield event;
  }
  if (!options.taskId || stopped || options.stopped() || options.abortController?.signal.aborted)
    return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await options.loadStatus();
    if (!status || !shouldSupplementAgentReview(options.prompt, toolNames, status, options.taskId))
      return;
    if (options.stopped() || options.abortController?.signal.aborted) return;
    options.abortController?.signal.addEventListener('abort', abort, { once: true });
    options.onReviewStart?.();
    timeout = setTimeout(() => {
      // User steering turns this continuation back into user work.
      if (!options.wasReviewSteered?.()) abort();
    }, options.timeoutMs ?? 90_000);
    yield {
      type: 'complete',
      threadId,
      content: [{ type: 'thinking', text: '正在检查本次任务的长期记忆和可复用技能。' }],
    };
    const reviewPrompt = `Disco 任务收尾检查（taskId=${options.taskId}）。用户任务已作答，本次仅补做尚未完成的学习评估，最多一次。\n先检查用户是否禁止记录或要求只读；如果明确禁止，立即结束且不写入。否则依据刚才的对话评估记忆和技能。若已得到可重复使用、包含具体经验且已实际验证的方法，应主动保存或更新当前智能体技能。不得重复用户任务、执行新的外部操作或进行额外实验。${status.consolidationDue ? `当前已达到记忆整理条件，先用 ${DISCO_MCP_METHOD_NAMES.agentLearningReview} inspect 读取最新原文，再生成保留来源、重要约束和不确定性的精简摘要。` : '现有记忆已预加载，无需重复 inspect；需要纠正原文时再读取。没有可复用信息时不要创建内容。'}完成后调用 ${DISCO_MCP_METHOD_NAMES.agentLearningReview} 的 complete 记录两个判断。不能完成整理时提供 deferReason，不得声称已完成。无需再给用户一份最终回答。`;
    for await (const event of options.run(reviewPrompt, controller)) {
      // Maintenance text is not a second answer. Managed tool calls remain visible and audited.
      if (event.type === 'partial' && !options.wasReviewSteered?.()) continue;
      if (event.type === 'stopped') {
        if (options.abortController?.signal.aborted || options.stopped()) yield event;
        break;
      }
      if (event.type === 'complete') {
        yield {
          ...event,
          content: options.wasReviewSteered?.()
            ? event.content
            : event.content.filter((block) => block.type !== 'text' && block.type !== 'thinking'),
          ...(event.usage ? { usage: combinedUsage(usage, event.usage) } : {}),
        };
      } else if (event.type === 'usage_snapshot') {
        yield { ...event, usage: combinedUsage(usage, event.usage) };
      } else {
        yield event;
      }
    }
    const after = await options.loadStatus();
    if (
      !after?.reviews.some((review) => review.taskId === options.taskId) &&
      !options.stopped() &&
      !options.abortController?.signal.aborted
    ) {
      console.warn('[agent.learning] Supplementary review incomplete; retained for a later task');
    }
  } catch (error) {
    if (options.wasReviewSteered?.()) throw error;
    // A successful user task must not be rewritten as failed because optional learning failed.
    console.warn(
      '[agent.learning] Supplementary review unavailable; original task result preserved'
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    options.abortController?.signal.removeEventListener('abort', abort);
    options.onReviewEnd?.();
  }
}
