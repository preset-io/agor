import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Find all command files
const commandFiles = glob.sync('src/commands/**/*.ts');
const libFiles = glob.sync('src/lib/**/*.ts');
const hookFiles = glob.sync('src/hooks/**/*.ts');
const baseCommandFile = ['src/base-command.ts'];

// Create entry points
const entries = Object.fromEntries(
  [...commandFiles, ...libFiles, ...hookFiles, ...baseCommandFile].map(file => [
    file.replace(/^src\//, '').replace(/\.ts$/, ''),
    file,
  ])
);

export default defineConfig({
  entry: entries,
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  outDir: 'dist',
  external: [/^@agor\/core/],
});
