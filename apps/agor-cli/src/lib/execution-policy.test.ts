import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import { executionPolicyFor } from './execution-policy';

describe('executionPolicyFor', () => {
  it.each([
    ['login', 'bootstrap'],
    ['auth:login', 'bootstrap'],
    ['daemon:start', 'local'],
    ['db:migrate', 'local'],
    ['repo:add-local', 'local'],
    ['branch:cd', 'local'],
    ['repo:list', 'connection'],
    ['session:list', 'connection'],
    ['user:list', 'connection'],
  ] as const)('classifies %s as %s', (command, policy) => {
    expect(executionPolicyFor(command)).toBe(policy);
  });

  it('keeps connection commands out of local database internals', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts'))
      .flatMap((path) => {
        const commandId = path
          .replace(/\.ts$/, '')
          .replace(/\/index$/, '')
          .replaceAll('/', ':');
        if (executionPolicyFor(commandId) !== 'connection') return [];
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        return /\b(?:createDatabase|createDatabaseAsync|getDatabaseUrl)\b/.test(source)
          ? [commandId]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it('routes remote service commands through the shared BaseCommand client', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const storedAuthOnlyCommands = new Set(['auth:whoami', 'open', 'whoami']);
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('/index.ts'))
      .flatMap((path) => {
        const commandId = path
          .replace(/\.ts$/, '')
          .replace(/\/index$/, '')
          .replaceAll('/', ':');
        if (
          executionPolicyFor(commandId) !== 'connection' ||
          storedAuthOnlyCommands.has(commandId)
        ) {
          return [];
        }
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        return source.includes('extends BaseCommand') ? [] : [commandId];
      });

    expect(violations).toEqual([]);
  });
});
