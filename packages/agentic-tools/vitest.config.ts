import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@disco/agentic-tool-opencode/ui',
        replacement: source('../agentic-tool-opencode/src/ui/index.ts'),
      },
      {
        find: /^@disco\/agentic-tool-opencode$/,
        replacement: source('../agentic-tool-opencode/src/shared/index.ts'),
      },
      { find: /^@disco\/core\/(.+)$/, replacement: `${source('../core/src')}/$1` },
      { find: '@disco/core', replacement: source('../core/src/index.ts') },
    ],
  },
  test: { include: ['src/**/*.test.ts'] },
});
