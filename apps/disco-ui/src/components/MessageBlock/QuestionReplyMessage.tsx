import { Flex, Typography, theme } from 'antd';
import {
  formatQuestionReply,
  type QuestionReply,
  questionAnswerText,
} from '../../utils/questionReply';
import { CopyableContent } from '../CopyableContent';

export function QuestionReplyMessage({ reply }: { reply: QuestionReply }) {
  const { token } = theme.useToken();
  return (
    <div className="disco-message-row is-user">
      <div className="disco-message-surface">
        <CopyableContent
          textContent={formatQuestionReply(reply)}
          copyTooltip="复制回答"
          copiedTooltip="已复制"
        >
          <article aria-label="提问回复">
            <Flex vertical gap={token.marginSM}>
              <Typography.Text type="secondary">
                {reply.status === 'submitted' ? '已回答' : '已跳过本次提问'}
              </Typography.Text>
              {reply.status === 'submitted' &&
                reply.answers.map((answer, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Submitted answers never reorder; the legacy protocol has no question ids and can repeat question text.
                  <Flex key={`${index}:${answer.question}`} vertical gap={token.marginXXS}>
                    <Typography.Text
                      type="secondary"
                      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                    >
                      {answer.question}
                    </Typography.Text>
                    <Typography.Paragraph
                      style={{ marginBottom: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                    >
                      {questionAnswerText(answer)}
                    </Typography.Paragraph>
                  </Flex>
                ))}
            </Flex>
          </article>
        </CopyableContent>
      </div>
    </div>
  );
}
