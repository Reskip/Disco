import type { DiscoClient, Message, WidgetMessageMetadata } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonProps } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, storeTokens } from '../../utils/tokenRefresh';
import { QuestionRequestWidget } from './QuestionRequestWidget';
import { clearQuestionDrafts, getQuestionDraft } from './questionDrafts';

// cssstyle in jsdom cannot parse AntD 6's disabled text-button border variables.
// Keep native button interactions here; real AntD rendering is checked in Chrome.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Button: ({ children, disabled, loading, onClick, 'aria-label': label }: ButtonProps) => (
      <button
        type="button"
        disabled={disabled || Boolean(loading)}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
    ),
  };
});

const widget: WidgetMessageMetadata = {
  widget_id: 'question-a' as never,
  widget_type: 'questions',
  schema_version: 1,
  status: 'pending',
  requested_at: '2026-09-14T12:00:00Z',
  params: {
    questions: [
      {
        id: 'choice',
        question: '选择哪种方案？',
        options: [{ label: '方案 A', description: '先预览' }, { label: '方案 B' }],
      },
      { id: 'notes', question: '有哪些要求？' },
    ],
  },
};
const message = { session_id: 'session-a', metadata: { widget } } as Message;
function setup(value = widget, create = vi.fn(async () => ({}))) {
  const get = vi.fn(async () => ({ status: 'idle', agentic_tool: 'codex' }));
  const service = vi.fn(() => ({ create, get }));
  const client = { service } as unknown as DiscoClient;
  return {
    client,
    create,
    service,
    get,
    value,
    ui: <QuestionRequestWidget widget={value} message={message} client={client} />,
  };
}

describe('question card', () => {
  beforeEach(() => clearQuestionDrafts());
  it('clears drafts on logout and isolates deleted sessions', () => {
    const jwt = `e30.${btoa(JSON.stringify({ sub: 'qa-user', user_id: 'qa-user', tenant_id: 'default' }))}.signature`;
    storeTokens(jwt);
    const first = getQuestionDraft('s-a', 'q-a');
    first.setState({ answers: { q: { selected: [], text: 'private draft' } } });
    clearQuestionDrafts('s-b');
    expect(getQuestionDraft('s-a', 'q-a')).toBe(first);
    clearTokens();
    storeTokens(jwt);
    expect(getQuestionDraft('s-a', 'q-a').getState().answers).toEqual({});
    clearTokens();
  });
  it('does not resend a saved answer if the optional handoff fails', async () => {
    const fixture = setup();
    fixture.get.mockRejectedValue(new Error('connection lost after saving'));
    render(fixture.ui);
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('已跳过');
    await waitFor(() => expect(fixture.get).toHaveBeenCalledExactlyOnceWith('session-a'));
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();
  });
  it('respects questions with automatic continuation disabled', async () => {
    const fixture = setup({ ...widget, auto_resume: false });
    render(fixture.ui);
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('已跳过');
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it('does not preselect, keeps the draft across navigation, and submits once', async () => {
    const fixture = setup();
    const first = render(fixture.ui);
    expect(screen.getByRole('button', { name: '提交并继续' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /方案 A/u })).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '方案 B' }));
    fireEvent.change(screen.getByRole('textbox', { name: /有哪些要求/u }), {
      target: { value: '保留原文件' },
    });
    first.unmount();
    render(fixture.ui);
    expect(screen.getByRole('radio', { name: '方案 B' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: /有哪些要求/u })).toHaveValue('保留原文件');
    fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
    await screen.findByText('已回答');
    expect(fixture.service).toHaveBeenCalledWith('widgets/question-a/submit');
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      answers: {
        choice: { selected: ['方案 B'], text: '' },
        notes: { selected: [], text: '保留原文件' },
      },
    });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('keeps input on failure and allows retry or skip', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    const fixture = setup(widget, create);
    render(fixture.ui);
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: '跳过' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('已跳过');
    expect(create).toHaveBeenLastCalledWith({});
  });
  it('supports multiple choices, and renders persisted answers after refresh', async () => {
    const value = {
      ...widget,
      params: {
        questions: [
          {
            id: 'many',
            question: '选择功能',
            multiSelect: true,
            options: [{ label: '导入' }, { label: '导出' }],
          },
        ],
      },
    };
    const fixture = setup(value);
    const view = render(fixture.ui);
    fireEvent.click(screen.getByRole('checkbox', { name: '导入' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '导出' }));
    fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
    await screen.findByText('已回答');
    expect(fixture.create).toHaveBeenCalledWith({
      answers: { many: { selected: ['导入', '导出'], text: '' } },
    });
    view.unmount();
    clearQuestionDrafts();
    render(
      setup({
        ...value,
        status: 'submitted',
        result_meta: { answers: { many: { selected: ['导出'], text: 'CSV' } } },
      }).ui
    );
    expect(screen.getByText(/CSV/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交并继续' })).not.toBeInTheDocument();
  });
});
