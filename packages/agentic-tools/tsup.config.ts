import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', ui: 'src/ui.ts', config: 'src/config.ts' },
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: process.env.TSUP_CLEAN !== 'false',
  external: [
    '@disco/agentic-tool-opencode',
    /^@disco\/agentic-tool-opencode\//,
    '@disco/core',
    /^@disco\/core\//,
    'react',
  ],
});
