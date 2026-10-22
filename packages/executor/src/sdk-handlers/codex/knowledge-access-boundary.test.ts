import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDiscoKnowledgeAccessBoundary,
  resolveDiscoKnowledgePrivateRoots,
} from './knowledge-access-boundary';

describe('knowledge runtime private directory instructions', () => {
  it('excludes configured service storage, config parent and host Codex home while keeping owner library separate', () => {
    const privateRoot = resolve('fixture/server/openviking');
    const configRoot = resolve('fixture/server/knowledge');
    const hostHome = resolve('fixture/host-codex');
    const env = {
      DISCO_KNOWLEDGE_PRIVATE_ROOTS: JSON.stringify([privateRoot, privateRoot]),
      DISCO_KNOWLEDGE_CONFIG: join(configRoot, 'runtime.json'),
      DISCO_HOST_CODEX_HOME: hostHome,
      CODEX_HOME: resolve('fixture/disco-codex-runtime'),
    };
    expect(resolveDiscoKnowledgePrivateRoots(env)).toEqual([privateRoot, configRoot, hostHome]);
    const text = buildDiscoKnowledgeAccessBoundary(env);
    expect(text).toContain('优先于前述普通本机目录访问规则');
    expect(text).toContain('不要读取、修改或枚举');
    expect(text).toContain('只通过本轮授权的 Disco 知识库方法');
    expect(text).toContain('不要绕过鉴权直接调用知识库后端');
    expect(text).not.toContain(env.CODEX_HOME);
    expect(text).not.toContain('OS 隔离');
  });

  it('protects the default service directory without treating the runtime Codex home as the host home', () => {
    const dataHome = resolve('fixture/disco-data');
    expect(resolveDiscoKnowledgePrivateRoots({ DISCO_DATA_HOME: dataHome })).toEqual([
      join(dataHome, 'knowledge'),
    ]);
    expect(buildDiscoKnowledgeAccessBoundary({ CODEX_HOME: resolve('fixture/runtime') })).toBe('');
  });

  it.each(['not-json', '{}', '["relative/path"]', '[12]'])(
    'fails closed for invalid private-root configuration %s',
    (value) => {
      expect(() =>
        resolveDiscoKnowledgePrivateRoots({ DISCO_KNOWLEDGE_PRIVATE_ROOTS: value })
      ).toThrow('must be a JSON array of absolute paths');
    }
  );
});
