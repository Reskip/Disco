import type { QuestionAnswer, QuestionsParams, QuestionsResult } from '@disco-live/client';
import { Alert, Button, Card, Checkbox, Flex, Input, Radio, Space, Typography, theme } from 'antd';
import { useStore } from 'zustand';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';
import { continueQuestionReply } from './continueQuestionReply';
import { getQuestionDraft } from './questionDrafts';

const emptyAnswer: QuestionAnswer = { selected: [], text: '' };

export function QuestionRequestWidget({ widget, message, client }: WidgetComponentProps) {
  const { token } = theme.useToken();
  const params = widget.params as QuestionsParams;
  const draft = getQuestionDraft(message.session_id, widget.widget_id);
  const state = useStore(draft);
  const status = state.resolved ?? widget.status;
  const pending = status === 'pending';
  const results = widget.result_meta as QuestionsResult | undefined;
  const answers = results?.answers ?? state.answers;
  const complete = params.questions.every((question) => {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    return answer && (answer.selected.length > 0 || answer.text.trim().length > 0);
  });

  function updateAnswer(id: string, patch: Partial<QuestionAnswer>) {
    draft.setState((previous) => ({
      answers: {
        ...previous.answers,
        [id]: { ...(previous.answers[id] ?? emptyAnswer), ...patch },
      },
      error: null,
    }));
  }

  async function resolve(action: 'submit' | 'dismiss') {
    if (!client || !pending || draft.getState().submitting) return;
    draft.setState({ submitting: true, error: null });
    try {
      await client
        .service(`widgets/${encodeURIComponent(widget.widget_id)}/${action}`)
        .create(action === 'submit' ? { answers: draft.getState().answers } : {});
      draft.setState({ resolved: action === 'submit' ? 'submitted' : 'dismissed' });
      if (widget.auto_resume !== false) {
        // A handoff failure must not turn a saved answer into a failed submission
        // or submit it twice. Its durable continuation remains the fallback.
        await continueQuestionReply(client, message.session_id, widget.widget_id).catch(() => {});
      }
    } catch {
      draft.setState({ error: '提交未成功，请重试。你的回答已保留。' });
    } finally {
      draft.setState({ submitting: false });
    }
  }

  return (
    <Card size="small" style={{ maxWidth: 640, width: '100%' }}>
      <Flex vertical gap={token.marginMD}>
        <Typography.Text type="secondary">
          {status === 'submitted' ? '已回答' : status === 'dismissed' ? '已跳过' : '需要你补充'}
        </Typography.Text>
        {params.questions.map((question) => {
          const answer = Object.hasOwn(answers, question.id) ? answers[question.id]! : emptyAnswer;
          const options = (question.options ?? []).map((option) => ({
            value: option.label,
            label: (
              <Space orientation="vertical" size={0}>
                <Typography.Text>{option.label}</Typography.Text>
                {option.description && (
                  <Typography.Text type="secondary">{option.description}</Typography.Text>
                )}
              </Space>
            ),
          }));
          return (
            <Flex key={question.id} vertical gap={token.marginXS}>
              <Flex align="center" justify="space-between" gap={token.marginXS}>
                <Typography.Text strong id={`${widget.widget_id}-${question.id}`}>
                  {question.question}
                </Typography.Text>
                {pending && options.length > 0 && (
                  <Button
                    size="small"
                    type="text"
                    style={{ flexShrink: 0 }}
                    disabled={state.submitting || !answer.selected.length}
                    onClick={() => updateAnswer(question.id, { selected: [] })}
                  >
                    清除选择
                  </Button>
                )}
              </Flex>
              {pending ? (
                <>
                  {options.length > 0 &&
                    (question.multiSelect ? (
                      <Checkbox.Group
                        aria-labelledby={`${widget.widget_id}-${question.id}`}
                        disabled={state.submitting || !client}
                        value={answer.selected}
                        onChange={(selected) =>
                          updateAnswer(question.id, { selected: selected.map(String) })
                        }
                      >
                        <Flex vertical gap={token.marginXS}>
                          {options.map((option) => (
                            <Checkbox key={option.value} value={option.value}>
                              {option.label}
                            </Checkbox>
                          ))}
                        </Flex>
                      </Checkbox.Group>
                    ) : (
                      <Radio.Group
                        aria-labelledby={`${widget.widget_id}-${question.id}`}
                        disabled={state.submitting || !client}
                        value={answer.selected[0]}
                        onChange={(event) =>
                          updateAnswer(question.id, { selected: [String(event.target.value)] })
                        }
                      >
                        <Flex vertical gap={token.marginXS}>
                          {options.map((option) => (
                            <Radio key={option.value} value={option.value}>
                              {option.label}
                            </Radio>
                          ))}
                        </Flex>
                      </Radio.Group>
                    ))}
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    maxLength={6000}
                    aria-label={`${question.question}：自己的回答或补充`}
                    placeholder={options.length ? '也可以填写自己的答案或补充说明' : '填写你的回答'}
                    disabled={state.submitting || !client}
                    value={answer.text}
                    onChange={(event) => updateAnswer(question.id, { text: event.target.value })}
                  />
                </>
              ) : status === 'submitted' ? (
                <Typography.Paragraph
                  style={{ marginBottom: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {[...answer.selected, answer.text].filter(Boolean).join('\n')}
                </Typography.Paragraph>
              ) : null}
            </Flex>
          );
        })}
        {state.error && <Alert type="error" showIcon title={state.error} />}
        {pending && (
          <Flex gap={token.marginXS} wrap>
            <Button
              type="primary"
              disabled={!complete || !client}
              loading={state.submitting}
              onClick={() => void resolve('submit')}
            >
              提交并继续
            </Button>
            <Button
              aria-label="跳过"
              disabled={state.submitting || !client}
              onClick={() => void resolve('dismiss')}
            >
              跳过
            </Button>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

registerWidgetComponent('questions', QuestionRequestWidget);
