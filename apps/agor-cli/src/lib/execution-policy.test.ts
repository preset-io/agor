import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import { CONNECTED_DEPLOYMENT_COMMANDS, LOCAL_DEPLOYMENT_COMMANDS } from './command-groups';
import { executionPolicyFor } from './execution-policy';

describe('executionPolicyFor', () => {
  it.each([
    ['login', 'bootstrap'],
    ['daemon:start', 'local'],
    ['db:migrate', 'local'],
    ['local:add-repo', 'local'],
    ['local:create-admin', 'local'],
    ['open', 'connection'],
    ['repo:list', 'connection'],
    ['session:list', 'connection'],
    ['user:list', 'connection'],
    ['version', 'connection'],
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
    const targetOnlyCommands = new Set(['open', 'version']);
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('/index.ts'))
      .flatMap((path) => {
        const commandId = path
          .replace(/\.ts$/, '')
          .replace(/\/index$/, '')
          .replaceAll('/', ':');
        if (executionPolicyFor(commandId) !== 'connection' || targetOnlyCommands.has(commandId)) {
          return [];
        }
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        return source.includes('extends BaseCommand') ? [] : [commandId];
      });

    expect(violations).toEqual([]);
  });

  it('never mixes local database construction with a daemon client', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts'))
      .flatMap((path) => {
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        const constructsDatabase = /\b(?:createDatabase|createDatabaseAsync|getDatabaseUrl)\b/.test(
          source
        );
        const constructsClient =
          /\b(?:connectToDaemon|connectToLocalDaemon|createRestClient)\b/.test(source);
        return constructsDatabase && constructsClient ? [path] : [];
      });

    expect(violations).toEqual([]);
  });

  it('assigns every discovered root command to exactly one deployment group', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const discoveredRoots = new Set(
      globSync('**/*.ts', { cwd: commandsDir })
        .filter((path) => !path.endsWith('.test.ts'))
        .map((path) => path.split('/')[0].replace(/\.ts$/, ''))
    );
    const local = LOCAL_DEPLOYMENT_COMMANDS.map(({ name }) => name);
    const connected = CONNECTED_DEPLOYMENT_COMMANDS.map(({ name }) => name);

    const connectedNames = new Set<string>(connected);
    expect(local.filter((name) => connectedNames.has(name))).toEqual([]);
    expect([...new Set([...local, ...connected])].sort()).toEqual([...discoveredRoots].sort());
  });

  it('presents local-first target selectors with local deployment commands', () => {
    const local = LOCAL_DEPLOYMENT_COMMANDS.map(({ name }) => name);
    const connected = CONNECTED_DEPLOYMENT_COMMANDS.map(({ name }) => name);

    expect(local).toEqual(expect.arrayContaining(['open', 'version']));
    expect(connected).not.toEqual(expect.arrayContaining(['open', 'version']));
  });

  it('does not mix local deployment state with daemon-client access', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const allowedTargetSelectionCommands = new Set(['login.ts']);
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts') && !allowedTargetSelectionCommands.has(path))
      .flatMap((path) => {
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        const accessesLocalDeployment =
          /\b(?:createDatabase|createDatabaseAsync|getConfigPath|getDatabaseUrl|loadConfig)\b/.test(
            source
          );
        const accessesDaemonClient =
          /\b(?:connectToDaemon|connectToLocalDaemon|createRestClient)\b/.test(source);
        return accessesLocalDeployment && accessesDaemonClient ? [path] : [];
      });

    expect(violations).toEqual([]);
  });

  it('requires local commands to use the explicit local-daemon client boundary', () => {
    const commandsDir = resolve(import.meta.dirname, '../commands');
    const violations = globSync('**/*.ts', { cwd: commandsDir })
      .filter((path) => !path.endsWith('.test.ts'))
      .flatMap((path) => {
        const commandId = path
          .replace(/\.ts$/, '')
          .replace(/\/index$/, '')
          .replaceAll('/', ':');
        if (executionPolicyFor(commandId) !== 'local') return [];
        const source = readFileSync(resolve(commandsDir, path), 'utf8');
        return /\bconnectToDaemon\b/.test(source) ? [commandId] : [];
      });

    expect(violations).toEqual([]);
  });
});
