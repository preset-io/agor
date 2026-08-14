import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sudoersPath = resolve(import.meta.dirname, '../../../docker/sudoers/agor-daemon.sudoers');
const fixedArguments = '-rf --one-file-system --preserve-root=all -- ';

function parsedPrivilegedDeleteRules(): string[] {
  const cvtsudoers = '/usr/bin/cvtsudoers';
  if (!existsSync(cvtsudoers)) return [];
  const parsed = spawnSync(cvtsudoers, ['-f', 'json', sudoersPath], { encoding: 'utf8' });
  expect(parsed.status, parsed.stderr).toBe(0);

  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'command' && typeof child === 'string') commands.push(child);
      else visit(child);
    }
  };
  visit(JSON.parse(parsed.stdout));
  return commands.filter((command) => command.startsWith('/usr/bin/rm ^-rf '));
}

function posixExtendedRegexMatches(pattern: string, value: string): boolean {
  const result = spawnSync('/usr/bin/grep', ['-E', '-q', pattern], {
    input: `${value}\n`,
    encoding: 'utf8',
  });
  expect([0, 1], result.stderr).toContain(result.status);
  return result.status === 0;
}

describe('privileged branch deletion sudoers contract', () => {
  it('is valid sudoers syntax and uses only anchored argument regular expressions', () => {
    if (existsSync('/usr/sbin/visudo')) {
      const validation = spawnSync('/usr/sbin/visudo', ['-c', '-f', sudoersPath], {
        encoding: 'utf8',
      });
      expect(validation.status, validation.stderr).toBe(0);
    }

    const source = readFileSync(sudoersPath, 'utf8');
    expect(source).not.toMatch(/^agor .*\/usr\/bin\/rm (?!\^).*\*/m);
    const rules = parsedPrivilegedDeleteRules();
    if (existsSync('/usr/bin/cvtsudoers')) expect(rules).toHaveLength(8);
  });

  it('allows one exact branch root and denies extra operands or broader paths', () => {
    const rules = parsedPrivilegedDeleteRules();
    if (!existsSync('/usr/bin/cvtsudoers')) return;
    const argumentPatterns = rules.map((rule) => rule.slice('/usr/bin/rm '.length));
    const matches = (targetAndPossibleOperands: string) =>
      argumentPatterns.some((pattern) =>
        posixExtendedRegexMatches(pattern, fixedArguments + targetAndPossibleOperands)
      );

    for (const valid of [
      '/home/agorpg/.agor/worktrees/preset-io/agor/fix-delete',
      '/home/agorpg/.agor/worktrees/agor/fix-delete',
      '/home/max/agor/worktrees/preset-io/agor/fix-delete',
      '/home/max/agor/worktrees/agor/fix-delete',
      '/var/agor/worktrees/preset-io/agor/fix-delete',
      '/var/agor/worktrees/...a/repo/fix-delete',
      '/var/agor/worktrees/agor/fix-delete',
      '/var/agor/tenants/tenant-a/worktrees/preset-io/agor/fix-delete',
      '/var/agor/tenants/tenant-a/worktrees/agor/fix-delete',
    ]) {
      expect(matches(valid), valid).toBe(true);
    }

    for (const invalid of [
      '/var/agor/worktrees/preset-io/agor/fix-delete /etc',
      '/var/agor/worktrees/preset-io',
      '/var/agor/worktrees/preset-io/agor/fix-delete/nested',
      '/var/agor/worktrees/preset-io/agor/fix delete',
      '/var/agor/worktrees/preset-io/agor/../other',
      '/var/agor/worktrees/org/../other',
      '/var/agor/worktrees/.../repo/fix-delete',
      '/var/agor/worktrees/org/.../fix-delete',
      '/var/agor/worktrees/../other',
      '/home/../.agor/worktrees/agor/fix-delete',
      '/var/agor/repos/preset-io/agor/fix-delete',
      '/etc',
    ]) {
      expect(matches(invalid), invalid).toBe(false);
    }
  });
});
