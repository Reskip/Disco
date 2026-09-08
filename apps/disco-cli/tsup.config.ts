import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Find all command files
const commandFiles = glob.sync('src/commands/**/*.ts');
const libFiles = glob.sync('src/lib/**/*.ts');
const hookFiles = glob.sync('src/hooks/**/*.ts');
const baseCommandFile = ['src/base-command.ts'];

// Create entry points
const entries = Object.fromEntries(
  [...commandFiles, ...libFiles, ...hookFiles, ...baseCommandFile].map((file) => {
    const portablePath = file.replaceAll('\\', '/');
    return [portablePath.replace(/^src\//, '').replace(/\.ts$/, ''), file];
  })
);

export default defineConfig({
  entry: entries,
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  outDir: 'dist',
  external: [
    /^@disco\/core/,
    /^@disco\/daemon/,
    /^@disco-live\/client/,
    // Keep the optional platform package on Node's normal resolution path.
    // Bundling this CommonJS loader prevents its dynamic require from finding
    // the prebuilt package installed alongside disco-live.
    /^@lydell\/node-pty/,
  ],
});
