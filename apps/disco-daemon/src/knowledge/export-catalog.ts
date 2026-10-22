import type { KnowledgeEntry } from '@disco/core/types';
import { materialType, noteType, organization } from './organization.js';

const label = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_{}[\]<>#+!|]/g, '\\$&');

/** Archive navigation is derived; original Markdown and attachment bytes stay untouched. */
export function knowledgeExportGuide(
  entries: KnowledgeEntry[],
  files: ReadonlySet<string>,
  exportedAt: string
): Array<{ path: string; markdown: string }> {
  const link = (title: string, path: string | undefined) => {
    if (
      !path ||
      !files.has(path) ||
      path.includes('\\') ||
      path.includes(':') ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return label(title);
    return `[${label(title)}](${encodeURI(path).replace(/[()#?]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)})`;
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const active = entries.filter((entry) => !entry.historical);
  const historical = entries.filter((entry) => entry.historical);
  const notes = active.filter((entry) => entry.kind === 'note');
  const originals = active.filter((entry) => entry.kind !== 'note');
  const lines = [
    '# 资料目录',
    '',
    `导出时间（UTC）：${exportedAt}`,
    '',
    `本目录包含 ${notes.length} 篇知识笔记、${originals.length} 份原始资料和 ${historical.length} 份历史归档版本。点击标题可直接打开本地 Markdown，点击原件可打开附件。`,
    '',
    '自动整理内容仍需核对；“概览”只描述资料结构，不代表已逐条理解原件。',
    '',
  ];
  const append = (entry: KnowledgeEntry) => {
    const group = organization(entry);
    const badges =
      entry.kind === 'note'
        ? [
            noteType(entry) === 'overview'
              ? '结构概览'
              : noteType(entry) === 'summary'
                ? '摘要'
                : '知识',
            entry.humanEdited ? '人工维护' : '自动整理',
            group.state === 'reviewed' ? '已确认' : '待确认',
          ]
        : [
            entry.source === 'codex' ? 'Codex' : entry.source === 'disco' ? 'Disco' : '本地资料',
            ...(entry.parseStatus === 'unsupported' ? ['仅文件信息可检索'] : []),
            ...(entry.parseStatus === 'error' ? ['正文解析失败，原件保留'] : []),
          ];
    lines.push(`- ${link(entry.title, entry.relativePath)} · ${badges.join(' · ')}`);
    if (!files.has(entry.relativePath)) lines.push('  - Markdown 归档文件缺失。');
    for (const attachment of entry.attachments ?? []) {
      lines.push(
        `  - 原件：${link(attachment.name, attachment.relativePath)}${!attachment.relativePath || !files.has(attachment.relativePath) ? '（文件缺失）' : ''}`
      );
    }
    const references = new Map((entry.sourceReferences ?? []).map((source) => [source.id, source]));
    const sourceIds = new Set([
      ...references.keys(),
      ...(group.sourceEntryIds ?? []),
      ...(entry.derivedFrom ? [entry.derivedFrom.entryId] : []),
    ]);
    for (const id of sourceIds) {
      const source = byId.get(id);
      const title = source?.title ?? references.get(id)?.title ?? '原始资料';
      lines.push(`  - 整理来源：${link(title, source?.relativePath)}${source ? '' : '（已删除）'}`);
    }
  };
  const sorted = (items: KnowledgeEntry[]) =>
    [...items].sort(
      (a, b) =>
        Number(b.humanEdited) - Number(a.humanEdited) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
    );
  lines.push('## 知识笔记', '');
  if (!notes.length) lines.push('暂无知识笔记。', '');
  const topics = [...new Set(notes.map((entry) => organization(entry).topic))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN')
  );
  for (const topic of topics) {
    lines.push(`### ${label(topic)}`, '');
    for (const entry of sorted(notes.filter((entry) => organization(entry).topic === topic)))
      append(entry);
    lines.push('');
  }
  for (const [type, title] of [
    ['conversation', '会话归档'],
    ['document', '文档'],
    ['image', '图片'],
    ['file', '其他文件'],
  ] as const) {
    const items = originals.filter((entry) => materialType(entry) === type);
    lines.push(`## ${title}（${items.length}）`, '');
    for (const entry of sorted(items)) append(entry);
    if (!items.length) lines.push('暂无。');
    lines.push('');
  }
  if (historical.length) {
    lines.push(
      `## 历史归档版本（${historical.length}）`,
      '',
      '这些旧版本单独保留，不混入当前知识和原始资料。',
      ''
    );
    for (const entry of sorted(historical)) append(entry);
    lines.push('');
  }
  return [
    {
      path: 'README.md',
      markdown:
        '# Disco 资料库\n\n先打开 [资料目录](%E8%B5%84%E6%96%99%E7%9B%AE%E5%BD%95.md)，按主题浏览知识笔记，或按类型找到原始资料和附件。不需要连接 Disco 就能阅读这些普通文件。\n\n## 文件说明\n\n- `notes/`：人工笔记、自动摘要和结构概览。\n- `conversations/`、`documents/`：可读的会话与资料 Markdown。\n- `assets/`：上传和关联的原始附件。\n- `sources/`：完整原始记录及生成时保留的来源副本。\n- `revisions/`：保留的 Markdown 历史版本。\n- `.library/`：归属、标题、分类、来源版本和删除记录等元数据。迁移时请保留此隐藏目录。\n\n## 阅读与迁移\n\n解压后可用 Markdown 编辑器打开目录。目录中的链接指向包内文件；原文中已有的 Disco 站内链接仍需对应的 Disco 服务。文件名中的稳定编号用于保持引用关系，资料标题和分类见目录与元数据。\n\n完整备份请复制整个解压目录，包括隐藏目录。恢复到 Disco 时应保留原来的账户归属，不要混合不同用户的资料。直接修改 Markdown 后，Disco 会在后台同步并保护人工修改，自动总结不会覆盖它。\n\n本导出保留原始文件；索引可重新构建。图片或二进制文件“仅文件信息可检索”不表示已经识别其正文。目录和本说明是导出时生成的导航文件，不会替换原始内容。\n',
    },
    { path: '资料目录.md', markdown: `${lines.join('\n')}\n` },
  ];
}
