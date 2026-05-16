import { describe, expect, it } from 'vitest';
import {
  claudeProjectDir,
  claudeSessionJsonlPath,
  claudeSubagentsDir,
  slugForCwd,
} from './path-utils.js';

describe('slugForCwd', () => {
  it('replaces / and . with -', () => {
    expect(slugForCwd('/Users/max/projects/agor')).toBe('-Users-max-projects-agor');
    expect(slugForCwd('/tmp/foo.bar/baz')).toBe('-tmp-foo-bar-baz');
  });

  it('double-dashes dotfile directories', () => {
    // Verified live: leading `.` in `.agor` → `-`, plus the surrounding `/`
    // separators also → `-`, producing the `--` doubling.
    expect(slugForCwd('/home/agor/.agor/repos/agor')).toBe('-home-agor--agor-repos-agor');
  });

  it('matches the live analysis-worktree sample', () => {
    expect(
      slugForCwd(
        '/var/lib/agor/home/agorpg/.agor/worktrees/preset-io/agor/analyze-claude-code-cli-integration'
      )
    ).toBe(
      '-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration'
    );
  });
});

describe('claudeProjectDir', () => {
  it('joins home with .claude/projects/<slug>', () => {
    expect(claudeProjectDir('/home/agor', '/tmp/foo')).toEqual({
      slug: '-tmp-foo',
      dir: '/home/agor/.claude/projects/-tmp-foo',
    });
  });
});

describe('claudeSessionJsonlPath', () => {
  it('appends <sessionId>.jsonl', () => {
    expect(claudeSessionJsonlPath('/home/agor', '/tmp/foo', 'abc-123')).toBe(
      '/home/agor/.claude/projects/-tmp-foo/abc-123.jsonl'
    );
  });
});

describe('claudeSubagentsDir', () => {
  it('returns <slug>/<sessionId>/subagents', () => {
    expect(claudeSubagentsDir('/home/agor', '/tmp/foo', 'abc-123')).toBe(
      '/home/agor/.claude/projects/-tmp-foo/abc-123/subagents'
    );
  });
});
