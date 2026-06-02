#!/usr/bin/env node

/**
 * Post-build script: removes @agor/core/types import from generated .d.ts files
 * so the published @agor-live/client package is fully self-contained.
 *
 * The DTS build inlines most types but leaves one import from @agor/core/types
 * because api/index.ts uses it internally. The imported types are aliased (Session$1, etc.)
 * and used in ServiceTypes. The same types are also declared locally in the file.
 * We strip the import and rewrite $1 references to point to the local declarations.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

for (const file of ['index.d.ts', 'index.d.cts']) {
  const path = join(distDir, file);
  if (!existsSync(path)) {
    continue;
  }

  let content = readFileSync(path, 'utf8');

  if (content.includes("from '@agor/core/types'")) {
    // Remove the @agor/core/types import line
    content = content.replace(/import \{[^}]+\} from '@agor\/core\/types';\n?/, '');
    // Fix $1 suffixed type references to use the locally declared types
    content = content.replace(/(\w+)\$1/g, '$1');
    writeFileSync(path, content);
    console.log(`✅ Patched ${file} — removed @agor/core/types import`);
  } else {
    console.log(`✓ ${file} — no @agor/core references found`);
  }
}
