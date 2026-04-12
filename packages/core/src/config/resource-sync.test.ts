/**
 * Tests for pure sync logic functions (resource-sync.ts)
 */

import { describe, expect, it } from 'vitest';
import {
  buildSlugToRepoIdMap,
  determineRepoAction,
  determineUserAction,
  determineWorktreeAction,
  resolvePassword,
} from './resource-sync';

// ---------------------------------------------------------------------------
// determineRepoAction
// ---------------------------------------------------------------------------

describe('determineRepoAction', () => {
  it('returns create when no existing repo', () => {
    expect(determineRepoAction({ remote_url: 'https://example.com/repo' }, null)).toBe('create');
  });

  it('returns unchanged when existing matches config', () => {
    const existing = { remote_url: 'https://example.com/repo', default_branch: 'main' };
    const config = { remote_url: 'https://example.com/repo', default_branch: 'main' };
    expect(determineRepoAction(config, existing)).toBe('unchanged');
  });

  it('returns update when remote_url differs', () => {
    const existing = { remote_url: 'https://old.com/repo', default_branch: 'main' };
    const config = { remote_url: 'https://new.com/repo' };
    expect(determineRepoAction(config, existing)).toBe('update');
  });

  it('returns update when default_branch differs', () => {
    const existing = { remote_url: 'https://example.com/repo', default_branch: 'main' };
    const config = { default_branch: 'develop' };
    expect(determineRepoAction(config, existing)).toBe('update');
  });

  it('returns unchanged when config fields are undefined', () => {
    const existing = { remote_url: 'https://example.com/repo', default_branch: 'main' };
    expect(determineRepoAction({}, existing)).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// determineWorktreeAction
// ---------------------------------------------------------------------------

describe('determineWorktreeAction', () => {
  it('returns create when no existing worktree', () => {
    expect(determineWorktreeAction({ ref: 'main' }, null)).toBe('create');
  });

  it('returns unchanged when existing matches', () => {
    const existing = { ref: 'main', others_can: 'session', mcp_server_ids: ['a'] };
    const config = { ref: 'main', others_can: 'session', mcp_server_ids: ['a'] };
    expect(determineWorktreeAction(config, existing)).toBe('unchanged');
  });

  it('returns update when ref differs', () => {
    const existing = { ref: 'main' };
    const config = { ref: 'develop' };
    expect(determineWorktreeAction(config, existing)).toBe('update');
  });

  it('returns update when others_can differs', () => {
    const existing = { ref: 'main', others_can: 'session' };
    const config = { ref: 'main', others_can: 'all' };
    expect(determineWorktreeAction(config, existing)).toBe('update');
  });

  it('returns update when mcp_server_ids differ', () => {
    const existing = { ref: 'main', mcp_server_ids: ['a'] };
    const config = { ref: 'main', mcp_server_ids: ['a', 'b'] };
    expect(determineWorktreeAction(config, existing)).toBe('update');
  });

  it('returns unchanged when optional fields are undefined in config', () => {
    const existing = { ref: 'main', others_can: 'session', mcp_server_ids: ['a'] };
    const config = { ref: 'main' };
    expect(determineWorktreeAction(config, existing)).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// determineUserAction
// ---------------------------------------------------------------------------

describe('determineUserAction', () => {
  it('returns create when no existing user', () => {
    expect(determineUserAction({ name: 'Alice' }, null)).toBe('create');
  });

  it('returns unchanged when existing matches', () => {
    const existing = { name: 'Alice', role: 'member', unix_username: 'alice' };
    const config = { name: 'Alice', role: 'member', unix_username: 'alice' };
    expect(determineUserAction(config, existing)).toBe('unchanged');
  });

  it('returns update when name differs', () => {
    const existing = { name: 'Alice' };
    const config = { name: 'Bob' };
    expect(determineUserAction(config, existing)).toBe('update');
  });

  it('returns update when role differs', () => {
    const existing = { name: 'Alice', role: 'member' };
    const config = { name: 'Alice', role: 'admin' };
    expect(determineUserAction(config, existing)).toBe('update');
  });

  it('returns update when unix_username differs', () => {
    const existing = { name: 'Alice', unix_username: 'alice' };
    const config = { name: 'Alice', unix_username: 'alice2' };
    expect(determineUserAction(config, existing)).toBe('update');
  });

  it('returns unchanged when config fields are undefined', () => {
    const existing = { name: 'Alice', role: 'admin', unix_username: 'alice' };
    expect(determineUserAction({}, existing)).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// resolvePassword
// ---------------------------------------------------------------------------

describe('resolvePassword', () => {
  it('generates random password when undefined', () => {
    const result = resolvePassword(undefined);
    expect(result.mustChange).toBe(true);
    expect(result.password).toHaveLength(32); // 16 bytes → 32 hex chars
    expect(result.password).toMatch(/^[0-9a-f]+$/);
  });

  it('generates random password when empty string', () => {
    const result = resolvePassword('');
    expect(result.mustChange).toBe(true);
    expect(result.password).toHaveLength(32);
  });

  it('returns literal password as-is', () => {
    const result = resolvePassword('my-secret');
    expect(result.password).toBe('my-secret');
    expect(result.mustChange).toBe(false);
  });

  it('resolves Handlebars env template', () => {
    const result = resolvePassword('{{env.MY_SECRET}}', { MY_SECRET: 'hunter2' });
    expect(result.password).toBe('hunter2');
    expect(result.mustChange).toBe(false);
  });

  it('resolves multiple Handlebars refs', () => {
    const result = resolvePassword('{{env.USER}}-{{env.PASS}}', {
      USER: 'admin',
      PASS: 'secret',
    });
    expect(result.password).toBe('admin-secret');
    expect(result.mustChange).toBe(false);
  });

  it('handles whitespace in Handlebars template', () => {
    const result = resolvePassword('{{ env.MY_VAR }}', { MY_VAR: 'value' });
    expect(result.password).toBe('value');
    expect(result.mustChange).toBe(false);
  });

  it('throws on missing env var in Handlebars template', () => {
    expect(() => resolvePassword('{{env.MISSING}}', {})).toThrow(
      'Environment variable MISSING is not set'
    );
  });

  it('throws on empty env var in Handlebars template', () => {
    expect(() => resolvePassword('{{env.EMPTY}}', { EMPTY: '' })).toThrow(
      'Environment variable EMPTY is not set'
    );
  });

  it('throws on unrecognized template expression', () => {
    expect(() => resolvePassword('{{typo}}', {})).toThrow(
      'Unrecognized template expression {{typo}}'
    );
  });

  it('throws on unknown namespace in template', () => {
    expect(() => resolvePassword('{{secret.KEY}}', {})).toThrow(
      'Unrecognized template expression {{secret.KEY}}'
    );
  });

  it('throws when mixing valid and invalid templates', () => {
    expect(() => resolvePassword('{{env.OK}}-{{bad}}', { OK: 'val' })).toThrow(
      'Unrecognized template expression {{bad}}'
    );
  });
});

// ---------------------------------------------------------------------------
// buildSlugToRepoIdMap
// ---------------------------------------------------------------------------

describe('buildSlugToRepoIdMap', () => {
  it('builds map from repos', () => {
    const repos = [
      { repo_id: 'id-1', slug: 'org/repo-a' },
      { repo_id: 'id-2', slug: 'org/repo-b' },
    ];
    const map = buildSlugToRepoIdMap(repos);
    expect(map.get('org/repo-a')).toBe('id-1');
    expect(map.get('org/repo-b')).toBe('id-2');
    expect(map.size).toBe(2);
  });

  it('returns empty map for empty input', () => {
    expect(buildSlugToRepoIdMap([]).size).toBe(0);
  });
});
