import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandPurposeClassifier,
  classifyCommandPurposeLocally,
  commandPurposeExactKey,
  commandPurposePatternKey,
} from './command-purpose-classifier.js';

const temporaryDirectories: string[] = [];

async function cacheFile(name: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-command-purpose-'));
  temporaryDirectories.push(directory);
  return path.join(directory, `${name}.json`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('CommandPurposeClassifier', () => {
  it('classifies the reported compound NCM inspection by its overall purpose', () => {
    const command = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$p = ".disco/session-staging/01a0477c/upl_64e01994/2NE1.ncm"; Get-Item -LiteralPath $p; Format-Hex -LiteralPath $p -Count 64; where.exe ffmpeg; where.exe ffprobe; where.exe ncmdump'`;

    expect(classifyCommandPurposeLocally(command)).toMatchObject({
      label: '检查媒体文件与转码工具',
      source: 'rule',
      needsModel: false,
    });
  });

  it.each([
    ['powershell.exe -Command "git --version"', '检查 Git 工具'],
    ['pwsh.exe -Command "git.exe status --short"', '检查代码变更'],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" rev-parse --show-toplevel', '检查 Git 工作区'],
    ['powershell.exe -Command "git fetch --all --prune"', '获取代码更新'],
    ['powershell.exe -Command "git push origin main"', '推送代码更新'],
    ['powershell.exe -Command "git commit -m test"', '记录代码变更'],
    ['powershell.exe -Command "git switch feature/test"', '调整 Git 工作区'],
    ['powershell.exe -Command "git maintenance run"', '执行 Git 操作'],
  ])('classifies Git command families without falling back to the shell (%s)', (command, label) => {
    expect(classifyCommandPurposeLocally(command)).toMatchObject({
      label,
      source: 'rule',
      needsModel: false,
    });
  });

  it('does not mistake a .git path for a Git CLI command', () => {
    expect(
      classifyCommandPurposeLocally(
        'powershell.exe -Command "Get-Content C:\\workspace\\.git\\config"'
      )
    ).toMatchObject({ label: '读取文件内容' });
  });

  it('uses a full-command cache and does not call the model twice', async () => {
    let modelCalls = 0;
    const classifier = new CommandPurposeClassifier({
      cacheFile: await cacheFile('exact'),
      model: async () => {
        modelCalls += 1;
        return { label: '核对自定义构建产物', confidence: 0.91 };
      },
    });
    const command = `powershell.exe -Command "custom-build-tool --inspect alpha.widget"`;

    expect((await classifier.refine(command)).source).toBe('model');
    expect(await classifier.refine(command)).toMatchObject({
      label: '核对自定义构建产物',
      source: 'exact-cache',
    });
    expect(modelCalls).toBe(1);
  });

  it('promotes a stable learned pattern after two distinct examples', async () => {
    let modelCalls = 0;
    const classifier = new CommandPurposeClassifier({
      cacheFile: await cacheFile('pattern'),
      model: async () => {
        modelCalls += 1;
        return { label: '核对自定义媒体容器', confidence: 0.9 };
      },
    });
    const first = String.raw`powershell.exe -Command "Get-Item 'C:\media\one.foo'; custom-probe 'C:\media\one.foo'"`;
    const second = String.raw`powershell.exe -Command "Get-Item 'D:\incoming\two.foo'; custom-probe 'D:\incoming\two.foo'"`;
    const third = String.raw`powershell.exe -Command "Get-Item 'E:\other\three.foo'; custom-probe 'E:\other\three.foo'"`;

    expect(commandPurposeExactKey(first)).not.toBe(commandPurposeExactKey(second));
    expect(commandPurposePatternKey(first)).toBe(commandPurposePatternKey(second));
    await classifier.refine(first);
    await classifier.refine(second);

    expect(await classifier.classifyImmediate(third)).toMatchObject({
      label: '核对自定义媒体容器',
      source: 'pattern-cache',
      needsModel: false,
    });
    expect(modelCalls).toBe(2);
  });

  it('persists hashes and labels without persisting the raw command', async () => {
    const file = await cacheFile('privacy');
    const classifier = new CommandPurposeClassifier({
      cacheFile: file,
      model: async () => ({ label: '检查私有格式文件', confidence: 0.88 }),
    });
    const command = String.raw`powershell.exe -Command "Get-Item 'E:\secret\family-private-name.zzz'"`;
    await classifier.refine(command);

    const serialized = await fs.readFile(file, 'utf8');
    expect(serialized).not.toContain('family-private-name');
    expect(serialized).not.toContain('E:\\secret');
    expect(serialized).toContain('检查私有格式文件');
  });

  it('expires exact model results and requests a fresh classification', async () => {
    let now = 1_000;
    let modelCalls = 0;
    const classifier = new CommandPurposeClassifier({
      cacheFile: await cacheFile('ttl'),
      now: () => now,
      exactTtlMs: 100,
      model: async () => {
        modelCalls += 1;
        return { label: '分析临时数据格式', confidence: 0.86 };
      },
    });
    const command = 'powershell.exe -Command "custom-analyze sample.tmpx"';

    await classifier.refine(command);
    now += 101;
    await classifier.refine(command);
    expect(modelCalls).toBe(2);
  });

  it('rejects low-confidence or generic model output', async () => {
    const classifier = new CommandPurposeClassifier({
      cacheFile: await cacheFile('invalid'),
      model: async () => ({ label: 'PowerShell', confidence: 0.99 }),
    });
    const command = 'powershell.exe -Command "custom-unknown-operation"';

    expect(await classifier.refine(command)).toMatchObject({
      label: '执行 PowerShell 命令',
      source: 'fallback',
      needsModel: true,
    });
  });
});
