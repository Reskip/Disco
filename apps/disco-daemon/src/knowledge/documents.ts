import { spawn } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import type { KnowledgeEntryDetail, KnowledgeOwner, KnowledgeParseStatus } from '@disco/core/types';
import type { KnowledgeLibrary } from './library';

export interface KnowledgeDocumentExtraction {
  parsed: boolean;
  status: 'parsed' | 'unsupported' | 'error' | 'protected';
  format?: string;
  message?: string;
  characters?: number;
  detail?: KnowledgeEntryDetail;
}

export interface KnowledgeDocumentParserOptions {
  pythonExecutable?: string;
  scriptPath?: string;
}

const textFormats = new Set([
  'txt',
  'md',
  'mdx',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'rst',
  'tex',
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'sh',
  'ps1',
  'sql',
  'toml',
  'ini',
  'conf',
  'c',
  'cpp',
  'h',
  'hpp',
  'rs',
  'go',
  'java',
  'kt',
  'swift',
  'vue',
  'svelte',
  'ipynb',
  'bib',
]);
const pythonFormats = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const safeHeading = (value: string) => value.replace(/[\r\n]/g, ' ');

async function readText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let decoder: TextDecoder | undefined;
  const chunks: string[] = [];
  for await (const bytes of stream) {
    // Unicode BOMs are detected without guessing a legacy encoding and corrupting the source.
    decoder ??= new TextDecoder(
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8',
      { fatal: true }
    );
    chunks.push(decoder.decode(bytes, { stream: true }));
  }
  if (decoder) chunks.push(decoder.decode());
  const result = chunks.join('');
  if (result.includes('\0')) throw new Error('文件包含二进制内容，不能作为纯文本解析。');
  return result;
}

async function runPythonParser(
  stream: NodeJS.ReadableStream,
  format: string,
  options: KnowledgeDocumentParserOptions
): Promise<string> {
  const executable = options.pythonExecutable ?? process.env.DISCO_KNOWLEDGE_PYTHON ?? 'python';
  const script =
    options.scriptPath ??
    process.env.DISCO_KNOWLEDGE_EXTRACT_SCRIPT ??
    resolve('scripts/knowledge-extract.py');
  // Only the operator-configured program/script and an allowlisted format become arguments.
  // Document bytes travel through stdin; the parser never receives a tenant filesystem path.
  const child = spawn(executable, [script, format], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  // Attach all rejection handlers before feeding stdin to avoid an unhandled EPIPE on parser failure.
  const input = pipeline(stream, child.stdin);
  const output = readText(child.stdout);
  const [inputResult, outputResult, exitResult] = await Promise.allSettled([input, output, exited]);
  if (exitResult.status === 'rejected')
    throw new Error('文档解析器未能启动，请检查服务器解析环境。');
  if (exitResult.value !== 0) {
    const detail = stderr.trim().split(/\r?\n/).at(-1);
    throw new Error(detail || '文档解析失败，原件已完整保留。');
  }
  if (inputResult.status === 'rejected') throw new Error('读取原始附件失败，原件已保留。');
  if (outputResult.status === 'rejected') throw new Error('文档解析器没有返回有效的 UTF-8 文本。');
  return outputResult.value;
}

/** Parse only an attachment already authorized and stored by KnowledgeLibrary. */
export async function extractKnowledgeDocument(
  library: KnowledgeLibrary,
  owner: KnowledgeOwner,
  id: string,
  options: KnowledgeDocumentParserOptions = {}
): Promise<KnowledgeDocumentExtraction> {
  const current = await library.get(owner, id);
  if (current?.entry.kind !== 'document')
    return { parsed: false, status: 'error', message: '资料不存在或不是文档。' };
  const finish = async (
    result: KnowledgeDocumentExtraction,
    status: KnowledgeParseStatus = result.parsed
      ? 'parsed'
      : result.status === 'unsupported'
        ? 'unsupported'
        : 'error'
  ): Promise<KnowledgeDocumentExtraction> => {
    await library.markParsed(owner, id, status, result.message);
    return { ...result, detail: (await library.get(owner, id)) ?? undefined };
  };
  // Previous originals remain downloadable, while extraction follows the newest saved version.
  const attachment = current.entry.attachments
    ?.slice()
    .reverse()
    .find((item) => item.id && item.relativePath);
  if (!attachment?.id)
    return finish({
      parsed: false,
      status: 'error',
      message: '资料原件尚未保存，不能解析。',
      detail: current,
    });
  const format = extname(attachment.name).slice(1).toLowerCase();
  const nativeText = textFormats.has(format) || attachment.mimeType?.startsWith('text/');
  let result: KnowledgeDocumentExtraction;
  let body = '';
  if (!nativeText && !pythonFormats.has(format)) {
    result = {
      parsed: false,
      status: 'unsupported',
      format,
      message: '原件已完整保存；此格式暂未解析，正文尚不能检索。',
    };
  } else {
    const opened = await library.openAttachment(owner, id, attachment.id);
    if (!opened)
      return finish({
        parsed: false,
        status: 'error',
        format,
        message: '原始附件不可读取。',
        detail: current,
      });
    try {
      body = nativeText
        ? await readText(opened.body)
        : await runPythonParser(opened.body, format, options);
      result = body.trim()
        ? { parsed: true, status: 'parsed', format, characters: body.length }
        : {
            parsed: false,
            status: 'unsupported',
            format,
            message:
              format === 'pdf'
                ? '原件已保存，但未提取到文本。扫描版 PDF 需要 OCR 后才能检索正文。'
                : '原件已保存，文档没有可提取的文本。',
          };
    } catch (error) {
      result = {
        parsed: false,
        status: 'error',
        format,
        message: error instanceof Error ? error.message : '文档解析失败，原件已保留。',
      };
    } finally {
      opened.body.destroy();
    }
  }
  const label = safeHeading(attachment.name).replace(/[[\]\\]/g, '\\$&');
  const markdown = `# ${safeHeading(current.entry.title)}\n\n[原始文件：${label}](../${attachment.relativePath})\n\n${result.parsed ? body : `> ${result.message}`}\n`;
  const detail = await library.upsertSource(owner, {
    source: current.entry.source,
    sourceId: current.entry.sourceId,
    kind: 'document',
    title: current.entry.title,
    markdown,
    sourceUpdatedAt: current.entry.sourceUpdatedAt,
    sourceUrl: current.entry.sourceUrl,
    attachments: current.entry.attachments,
  });
  if (!detail)
    return { parsed: false, status: 'error', format, message: '资料已删除，解析结果未重新入库。' };
  if (detail.entry.humanEdited)
    return finish(
      {
        ...result,
        status: 'protected',
        message: `人工编辑的 Markdown 已保留；提取结果保存在来源文件中。${result.message ?? ''}`,
        detail,
      },
      result.parsed ? 'parsed' : result.status === 'unsupported' ? 'unsupported' : 'error'
    );
  return finish({ ...result, detail });
}
