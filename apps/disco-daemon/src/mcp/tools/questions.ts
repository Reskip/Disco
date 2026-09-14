import { DISCO_MCP_METHOD_NAMES } from '@disco/core';
import { generateId } from '@disco/core/db';
import { BadRequest, Forbidden } from '@disco/core/feathers';
import type { MessageID, Session } from '@disco/core/types';
import { MessageRole } from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { findHostTaskForSession } from '../../utils/session-tasks.js';
import { questionsParamsSchema } from '../../widgets/questions/index.js';
import type { McpContext } from '../server.js';
import { sessionContextRequiredResult, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

export function registerQuestionTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    DISCO_MCP_METHOD_NAMES.askQuestions,
    {
      description:
        'Ask 1–3 necessary clarification questions in an interactive chat card. Supports single choice, multiple choice, and free text. Returns immediately with waiting_for_user, NOT an answer or approval. Continue independent work or end the turn; submitting or skipping the card automatically resumes the conversation. Do not repeat questions in plain text. Never request passwords or API keys here; use disco_widgets_request_env_vars for credentials.',
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: questionsParamsSchema,
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const sessionId = ctx.sessionId;
      const params = questionsParamsSchema.parse(args);
      const session = (await ctx.app
        .service('sessions')
        .get(sessionId, ctx.baseServiceParams)) as Session;
      if (session.created_by !== ctx.userId)
        throw new Forbidden('Only the session owner may ask questions here');
      const hostTask = await findHostTaskForSession(ctx.app, sessionId, ctx.baseServiceParams);
      if (hostTask?.status !== 'running') throw new BadRequest('Questions require a running task');
      const widgetId = generateId() as MessageID;
      await runWithMcpTenantDatabaseScope(ctx, (db) =>
        appendSystemMessage({
          app: ctx.app,
          db,
          sessionId,
          taskId: hostTask.task_id,
          content: params.questions.map((question) => question.question).join('\n'),
          contentPreview: params.questions[0]!.question.slice(0, 200),
          type: 'widget_request',
          role: MessageRole.SYSTEM,
          messageId: widgetId,
          metadata: {
            widget: {
              widget_type: 'questions',
              widget_id: widgetId,
              schema_version: 1,
              params,
              status: 'pending',
              requested_at: new Date().toISOString(),
              auto_resume: true,
            },
          },
        })
      );
      return textResult({
        widget_id: widgetId,
        status: 'waiting_for_user',
        message: '问题已显示。尚未收到答案；用户提交或跳过后会自动继续当前会话。',
      });
    }
  );
}
