import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Find all source files
const srcFiles = glob.sync('src/**/*.ts', { ignore: ['**/*.test.ts', '**/*.spec.ts'] });

// Create entry points
const entries = Object.fromEntries(
  srcFiles.map(file => [file.replace(/^src\//, '').replace(/\.ts$/, ''), file])
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
