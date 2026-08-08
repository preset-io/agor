import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

describe('immutable config.yaml boundary', () => {
  it('daemon production sources cannot import YAML persistence helpers', () => {
    const offenders = sourceFiles(sourceRoot).filter((file) =>
      /\b(createInitialConfig|rewriteConfigForTests|saveConfigForTests)\b/.test(
        readFileSync(file, 'utf8')
      )
    );
    expect(offenders).toEqual([]);
  });

  it('container entrypoints do not rewrite config.yaml', () => {
    const dockerDir = resolve(sourceRoot, '../../../docker');
    const offenders = readdirSync(dockerDir)
      .filter((name) => name.endsWith('.sh'))
      .filter((name) =>
        /(?:sed\s+-i|cat\s*>|mv\s+|cp\s+).*config\.yaml/.test(
          readFileSync(join(dockerDir, name), 'utf8')
        )
      );
    expect(offenders).toEqual([]);
  });
});
