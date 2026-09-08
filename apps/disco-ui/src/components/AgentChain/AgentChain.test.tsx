import type { Message } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache } from '../../hooks/useAuthenticatedUpload';
import { AgentChain } from './AgentChain';

afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

function failedSearchMessages(): Message[] {
  return [
    {
      message_id: 'assistant-search',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'search-1',
          name: 'web_search',
          input: { query: 'site:example.com Codex title generation' },
        },
      ],
    },
    {
      message_id: 'search-result',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'search-1',
          content: 'request failed',
          is_error: true,
        },
      ],
    },
  ] as unknown as Message[];
}

function completedToolMessages(
  name: string,
  input: Record<string, unknown>,
  options: { error?: boolean } = {}
): Message[] {
  return [
    {
      message_id: 'assistant-tool',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    },
    {
      message_id: 'tool-result',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: options.error ? 'failed' : 'ok',
          is_error: options.error,
        },
      ],
    },
  ] as unknown as Message[];
}

describe('AgentChain', () => {
  it('keeps an intermediate failure neutral in the outer summary and local to its detail', () => {
    render(
      <ConfigProvider>
        <AgentChain messages={failedSearchMessages()} isTaskRunning={false} isLatest={false} />
      </ConfigProvider>
    );

    expect(screen.queryByText(/操作需要注意/)).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('检索 example.com');

    fireEvent.click(screen.getByRole('button'));
    expect(
      document.querySelector('.disco-agent-chain-details .anticon-close-circle')
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen
        .getByText('检索 example.com', { selector: 'strong' })
        .closest('.disco-tool-block-header') as HTMLElement
    );
    expect(screen.getByText('example.com检索未完成')).toBeInTheDocument();
    expect(screen.getAllByText('Codex title generation')).toHaveLength(2);
  });

  it('keeps a live task in thinking state between a completed tool and the next action', () => {
    render(
      <ConfigProvider>
        <AgentChain messages={failedSearchMessages()} isTaskRunning isLatest />
      </ConfigProvider>
    );

    const summary = screen.getByRole('button');
    expect(summary).toHaveTextContent('正在整理检索结果');
    expect(summary.querySelector('.ant-spin')).toBeInTheDocument();

    fireEvent.click(summary);
    expect(screen.getByText('正在整理检索结果', { selector: 'strong' })).toBeInTheDocument();
  });

  it('describes PDF capability checks instead of showing a generic project command', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            command:
              "Get-Item -LiteralPath 'report.pdf'; Get-Command pdftotext,pdfinfo,pdftoppm -ErrorAction SilentlyContinue",
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('检查 PDF 解析工具');
    expect(screen.queryByText(/项目命令/)).not.toBeInTheDocument();
  });

  it('uses the executor-provided command purpose instead of reclassifying it in the UI', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            command: 'powershell.exe -Command "Get-Item sample.bin"',
            title: '核对媒体容器和转码环境',
            purposeSource: 'model',
            purposeConfidence: 0.91,
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('核对媒体容器和转码环境');
    expect(screen.queryByText('检查文件信息')).not.toBeInTheDocument();
  });

  it('uses an MCP title for node-repl work and rejects the meaningless JS label', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages(
            'node_repl.js',
            { title: '连接浏览器以检索公开线索', code: 'await browser.documentation()' },
            { error: true }
          )}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('连接浏览器以检索公开线索');
    expect(screen.queryByText(/已JS|已js|js已结束/)).not.toBeInTheDocument();
  });

  it('summarizes a search URL by its decoded query', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            command:
              'curl.exe "https://www.bing.com/search?q=%22%E7%A7%92%E9%92%88%E6%BB%B4%E7%AD%94%EF%BC%88%E5%8C%97%E4%BA%AC%EF%BC%89%E7%BD%91%E7%BB%9C%E6%8A%80%E6%9C%AF%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8%22+%E5%AD%97%E8%8A%82%E8%B7%B3%E5%8A%A8"',
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('检索“秒针滴答（北京）网络技术有限公司”');
  });

  it.each([
    {
      command:
        '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Start-Sleep -Seconds 20; Get-Process codex"',
      expected: '等待 20 秒后检查运行进程',
    },
    {
      command: 'Start-Sleep -Milliseconds 500',
      expected: '等待 0.5 秒后继续',
    },
    {
      command:
        '$names="CODEX_HOME","HOME"; foreach($n in $names){[Environment]::GetEnvironmentVariable($n)}',
      expected: '检查运行环境配置',
    },
    {
      command: 'py -m pip install --disable-pip-version-check pymupdf',
      expected: '安装 pymupdf',
    },
    {
      command: 'python -c "import fitz; doc=fitz.open(\'report.pdf\'); print(doc[0].get_text())"',
      expected: '提取 PDF 文本',
    },
    {
      command:
        "python -c \"import fitz; page=fitz.open('report.pdf')[0]; page.get_pixmap().save('preview.png')\"",
      expected: '生成 PDF 预览',
    },
  ])('describes concrete shell intent: $expected', ({ command, expected }) => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', { command })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent(expected);
    expect(screen.queryByText(/项目命令/)).not.toBeInTheDocument();
  });

  it('does not let a generic supplied wait title hide the full command intent', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            title: '短暂等待',
            command:
              'powershell.exe -Command "Start-Sleep -Seconds 2; Get-Content -LiteralPath \'result.json\'"',
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('读取 result.json');
    expect(screen.queryByText('短暂等待')).not.toBeInTheDocument();
  });

  it('does not label a substantive retry script as waiting just because it sleeps between attempts', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            title: '等待后继续',
            command:
              'powershell.exe -Command "for($i=0;$i -lt 3;$i++){ Invoke-WebRequest https://example.com/data.json -OutFile result.json; if(Test-Path result.json){break}; Start-Sleep -Seconds 2 }"',
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('访问 example.com');
    expect(screen.queryByText(/等待.*继续/)).not.toBeInTheDocument();
  });

  it('uses a concrete runtime fallback instead of the generic project-command label', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            command:
              '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "$value = 1; $value"',
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('处理脚本数据');
    expect(screen.queryByText(/项目命令/)).not.toBeInTheDocument();
  });

  it('summarizes an unlabelled PowerShell file write by its target', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('Bash', {
            command:
              'powershell.exe -Command "Set-Content -LiteralPath \'report.json\' -Value $json"',
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('写入 report.json');
    expect(screen.queryByText(/PowerShell 脚本/)).not.toBeInTheDocument();
  });

  it('uses nearby agent context to explain an otherwise generic shell action', () => {
    const messages = [
      {
        message_id: 'assistant-context-command',
        role: 'assistant',
        content: [
          { type: 'text', text: '我先核对上传文件的元数据。' },
          {
            type: 'tool_use',
            id: 'tool-context',
            name: 'Bash',
            input: { command: 'powershell.exe -Command "$value = 1; $value"' },
          },
        ],
      },
      {
        message_id: 'tool-context-result',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-context', content: '1' }],
      },
    ] as unknown as Message[];

    render(
      <ConfigProvider>
        <AgentChain messages={messages} isTaskRunning={false} isLatest={false} />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('核对上传文件的元数据');
  });

  it('keeps TodoWrite bookkeeping out of the chronological activity chain', () => {
    render(
      <ConfigProvider>
        <AgentChain
          messages={completedToolMessages('TodoWrite', {
            todos: [
              { content: '确认输入', status: 'completed' },
              { content: '实现改动', activeForm: '正在实现改动', status: 'in_progress' },
              { content: '运行测试', status: 'pending' },
            ],
          })}
          isTaskRunning={false}
          isLatest={false}
        />
      </ConfigProvider>
    );

    expect(screen.queryByText('更新任务计划')).not.toBeInTheDocument();
    expect(document.querySelector('.disco-agent-chain')).not.toBeInTheDocument();
  });

  it('renders a completed image-view action as an expandable thumbnail instead of code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Blob(['image bytes'], { type: 'image/png' }), { status: 200 })
      )
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:viewed-image'),
        revokeObjectURL: vi.fn(),
      })
    );
    const messages = [
      {
        message_id: 'assistant-view-image',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'view-image-1',
            name: 'ViewImage',
            input: { filename: 'schedule.png' },
          },
        ],
      },
      {
        message_id: 'view-image-result',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'view-image-1',
            content: [
              {
                type: 'image',
                upload_ref: 'upl_viewed_image',
                filename: 'schedule.png',
                mime_type: 'image/png',
                size: 128,
                available: true,
              },
            ],
          },
        ],
      },
    ] as unknown as Message[];

    render(
      <ConfigProvider>
        <AgentChain messages={messages} isTaskRunning={false} isLatest={false} />
      </ConfigProvider>
    );

    expect(screen.getByRole('button')).toHaveTextContent('查看了图片');
    fireEvent.click(screen.getByRole('button'));

    const thumbnail = await screen.findByRole('img', { name: 'schedule.png' });
    expect(thumbnail).toBeVisible();
    expect(screen.queryByText('查看了图片', { selector: 'strong' })).not.toBeInTheDocument();
    expect(thumbnail).toHaveAttribute('src', 'blob:viewed-image');
    fireEvent.click(thumbnail);
    await waitFor(() => {
      expect(document.querySelector('.disco-image-preview')).toBeInTheDocument();
    });
    expect(screen.queryByText('输入')).not.toBeInTheDocument();
    expect(screen.queryByText('输出')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/upl_viewed_image|schedule\.png.*available/u)
    ).not.toBeInTheDocument();
  });
});
