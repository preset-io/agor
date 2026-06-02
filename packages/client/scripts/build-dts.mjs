#!/usr/bin/env node

/**
 * Build bundled declaration files for @agor-live/client.
 *
 * tsup 8.5.1's built-in DTS path injects compilerOptions.baseUrl = ".",
 * which TypeScript 6 deprecates. Use rollup-plugin-dts directly so we can
 * keep the existing self-contained public declarations without relying on
 * the deprecated compiler option.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import dts from 'rollup-plugin-dts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const distDir = join(packageRoot, 'dist');
const tsconfig = join(packageRoot, 'tsconfig.json');

const entries = {
  index: join(packageRoot, 'src/index.ts'),
  config: join(packageRoot, 'src/config.ts'),
  yaml: join(packageRoot, 'src/yaml.ts'),
  jwt: join(packageRoot, 'src/jwt.ts'),
};

await mkdir(distDir, { recursive: true });

for (const [name, input] of Object.entries(entries)) {
  const bundle = await rollup({
    input,
    plugins: [dts({ tsconfig })],
  });

  await bundle.write({
    file: join(distDir, `${name}.d.ts`),
    format: 'es',
  });
  await bundle.close();
}
