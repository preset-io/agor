import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Production entries only; integration tests import other workspace sources.
const sourceOptions = { ignore: ['**/*.test.ts', '**/*.spec.ts'] };
const commandFiles = glob.sync('src/commands/**/*.ts', sourceOptions);
const libFiles = glob.sync('src/lib/**/*.ts', sourceOptions);
const hookFiles = glob.sync('src/hooks/**/*.ts', sourceOptions);
const baseCommandFile = ['src/base-command.ts'];

// Create entry points
const entries = Object.fromEntries(
  [...commandFiles, ...libFiles, ...hookFiles, ...baseCommandFile].map((file) => [
    file.replace(/^src\//, '').replace(/\.ts$/, ''),
    file,
  ])
);

export default defineConfig({
  entry: entries,
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  outDir: 'dist',
  external: [
    /^@agor\/core/,
    /^@agor\/daemon/,
    /^@agor-live\/client/,
    // Keep the optional platform package on Node's normal resolution path.
    // Bundling this CommonJS loader prevents its dynamic require from finding
    // the prebuilt package installed alongside agor-live.
    /^@lydell\/node-pty/,
  ],
});
