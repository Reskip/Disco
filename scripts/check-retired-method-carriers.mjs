import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = [
  'apps/disco-daemon/src',
  'apps/disco-ui/src',
  'packages/core/src',
  'packages/executor/src',
];
const productionSource = /\.(?:ts|tsx)$/u;
const excludedSource = /(?:\.test|\.spec|\.stories|\.d)\.(?:ts|tsx)$/u;
const forbidden = [
  {
    name: 'retired Agent method',
    pattern:
      /disco_(?:repos|branches|boards|cards|card_types|artifacts|schedules)_[a-z0-9_]+/gu,
  },
  { name: 'ghost upload method', pattern: /disco_upload_materialize/gu },
  {
    name: 'retired business repository',
    pattern: /\b(?:Repo|Branch|Board|Card|Artifact)Repository\b/gu,
  },
  {
    name: 'retired business identity column',
    pattern: /\b(?:branch_id|repo_id|board_id|card_id|artifact_id)\b/gu,
  },
  {
    name: 'retired active schema export',
    pattern: /export const (?:repos|branches|boards|cards|cardTypes|artifacts)\b/gu,
  },
];

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(target)));
    } else if (productionSource.test(entry.name) && !excludedSource.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

const failures = [];
for (const sourceRoot of sourceRoots) {
  for (const file of await sourceFiles(join(root, sourceRoot))) {
    const contents = await readFile(file, 'utf8');
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0;
      for (const match of contents.matchAll(rule.pattern)) {
        const line = contents.slice(0, match.index).split('\n').length;
        failures.push(`${relative(root, file)}:${line}: ${rule.name}: ${match[0]}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map(failure => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Retired Disco method carriers are absent from production source.');
