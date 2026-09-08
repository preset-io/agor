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
  it('daemon runtime sources cannot reload persisted config after bootstrap', () => {
    const allowed = new Set([resolve(sourceRoot, 'index.ts')]);
    const offenders = sourceFiles(sourceRoot).filter(
      (file) =>
        !allowed.has(resolve(file)) &&
        /\b(?:loadConfig|loadConfigSync|loadConfigFromFile|isUnixImpersonationEnabled|isUnixGroupRefreshNeeded|getDaemonUser)\b/.test(
          readFileSync(file, 'utf8')
        )
    );
    expect(offenders).toEqual([]);
  });

  it('daemon production sources cannot import test-only config reset helpers', () => {
    const offenders = sourceFiles(sourceRoot).filter(
      (file) =>
        !file.endsWith('build-resolved-config-slice.ts') &&
        /\bresetResolvedConfigSliceForTests\b/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

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

  it('development Compose exposes only supported execution modes', () => {
    const compose = readFileSync(resolve(sourceRoot, '../../../docker-compose.yml'), 'utf8');

    expect(compose).toMatch(/AGOR_UNIX_USER_MODE=\$\{AGOR_UNIX_USER_MODE:-\}/);
    expect(compose).not.toMatch(/AGOR_(?:USE_EXECUTOR|EXECUTOR_USERNAME|DAEMON_UNIX_USER)=/);
  });
});
