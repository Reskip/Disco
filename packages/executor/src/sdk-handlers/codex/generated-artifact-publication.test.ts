import { describe, expect, it, vi } from 'vitest';
import {
  generatedArtifactPathsFromToolUses,
  publishGeneratedArtifacts,
} from './generated-artifact-publication.js';

describe('generated artifact publication bridge', () => {
  it('collects only host-declared generated artifacts across supported output kinds', () => {
    const declaration = JSON.stringify({
      type: 'disco_generated_artifacts',
      artifacts: [
        { path: 'E:/out/report.pdf' },
        { path: 'E:/out/audio.mp3' },
        { path: 'E:/out/video.mp4' },
        { path: 'E:/out/archive.zip' },
      ],
    });

    expect(
      generatedArtifactPathsFromToolUses([
        {
          id: 'image',
          name: 'image_generation',
          input: {},
          output: JSON.stringify({ savedPath: 'E:/out/image.png' }),
          status: 'completed',
        },
        {
          id: 'client',
          name: 'client.media.render',
          input: {},
          output: [{ type: 'inputText', text: declaration }],
          status: 'completed',
        },
        {
          id: 'shell',
          name: 'PowerShell',
          input: { command: 'write report.pdf' },
          output: JSON.stringify({ savedPath: 'E:/out/should-not-publish.pdf' }),
          status: 'completed',
        },
        {
          id: 'view',
          name: 'ViewImage',
          input: { path: 'E:/out/input.png' },
          status: 'completed',
        },
      ])
    ).toEqual([
      'E:/out/image.png',
      'E:/out/report.pdf',
      'E:/out/audio.mp3',
      'E:/out/video.mp4',
      'E:/out/archive.zip',
    ]);
  });

  it('does not republish a generated path already delivered explicitly', () => {
    const publication = JSON.stringify({
      type: 'disco_file_publication',
      published: true,
      files: [{ ref: 'upl_1' }],
    });
    expect(
      generatedArtifactPathsFromToolUses([
        {
          id: 'image',
          name: 'image_generation',
          input: {},
          output: JSON.stringify({ savedPath: 'E:/out/image.png' }),
          status: 'completed',
        },
        {
          id: 'publish',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: 'E:/out/image.png' }] },
          output: publication,
          status: 'completed',
        },
      ])
    ).toEqual([]);
  });

  it('publishes all generated media through the authenticated current-session MCP call', async () => {
    const files = [
      { ref: 'upl_image', filename: 'image.png', mimeType: 'image/png', size: 1 },
      { ref: 'upl_pdf', filename: 'report.pdf', mimeType: 'application/pdf', size: 2 },
      { ref: 'upl_audio', filename: 'audio.mp3', mimeType: 'audio/mpeg', size: 3 },
      { ref: 'upl_video', filename: 'video.mp4', mimeType: 'video/mp4', size: 4 },
      { ref: 'upl_file', filename: 'archive.zip', mimeType: 'application/zip', size: 5 },
    ];
    const payload = {
      type: 'disco_file_publication',
      published: true,
      sessionId: 'session-1',
      userId: 'user-1',
      files,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: payload },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const filePaths = [
      'E:/out/image.png',
      'E:/out/report.pdf',
      'E:/out/audio.mp3',
      'E:/out/video.mp4',
      'E:/out/archive.zip',
    ];

    const result = await publishGeneratedArtifacts({
      daemonUrl: 'http://127.0.0.1:3030/',
      sessionToken: 'session-token',
      filePaths,
      fetchImpl,
    });

    expect(result).toEqual([
      expect.objectContaining({
        name: 'disco.disco_files_publish',
        input: { files: filePaths.map((filePath) => ({ path: filePath })), automatic: true },
        output: JSON.stringify(payload),
        status: 'completed',
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3030/mcp');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer session-token' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'disco_files_publish',
        arguments: { files: filePaths.map((filePath) => ({ path: filePath })) },
      },
    });
  });

  it('accepts the bounded SSE response returned by a stateless MCP tools/call', async () => {
    const payload = {
      type: 'disco_file_publication',
      published: true,
      sessionId: 'session-1',
      userId: 'user-1',
      files: [{ ref: 'upl_image', filename: 'image.png', mimeType: 'image/png', size: 433_702 }],
    };
    const rpc = {
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      },
      jsonrpc: '2.0',
      id: 'disco-auto-publish-1',
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const result = await publishGeneratedArtifacts({
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'session-token',
      filePaths: ['E:/out/image.png'],
      fetchImpl,
    });

    expect(result).toEqual([
      expect.objectContaining({
        name: 'disco.disco_files_publish',
        status: 'completed',
        output: JSON.stringify(payload),
      }),
    ]);
  });

  it('returns a failed publication record when the session has no MCP token', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await publishGeneratedArtifacts({
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: undefined,
      filePaths: ['E:/out/image.png'],
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      name: 'disco.disco_files_publish',
      status: 'failed',
      output: '当前会话缺少文件发布凭据',
    });
  });
});
