import { describe, expect, it } from 'vitest';
import type { RepoSlug, WorktreeName } from '../types';
import {
  extractSlugFromUrl,
  formatRepoReference,
  isValidGitUrl,
  isValidSlug,
  parseRepoReference,
  resolveRepoReference,
} from './repo-reference';

describe('parseRepoReference', () => {
  describe('absolute paths', () => {
    it('should parse Unix absolute path', () => {
      const result = parseRepoReference('/Users/max/code/agor');
      expect(result).toEqual({
        type: 'path',
        path: '/Users/max/code/agor',
      });
    });

    it('should parse root path', () => {
      const result = parseRepoReference('/');
      expect(result).toEqual({
        type: 'path',
        path: '/',
      });
    });

    it('should parse nested Unix path', () => {
      const result = parseRepoReference('/var/www/projects/my-app');
      expect(result).toEqual({
        type: 'path',
        path: '/var/www/projects/my-app',
      });
    });

    it('should parse Windows path with C drive', () => {
      const result = parseRepoReference('C:\\Users\\max\\code\\agor');
      expect(result).toEqual({
        type: 'path',
        path: 'C:\\Users\\max\\code\\agor',
      });
    });

    it('should parse Windows path with D drive', () => {
      const result = parseRepoReference('D:\\Projects\\agor');
      expect(result).toEqual({
        type: 'path',
        path: 'D:\\Projects\\agor',
      });
    });

    it('should parse Windows path with forward slashes as worktree ref', () => {
      const result = parseRepoReference('C:/Users/max/code/agor');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'C',
        worktree: '/Users/max/code/agor',
      });
    });

    it('should parse path with spaces', () => {
      const result = parseRepoReference('/Users/max/My Projects/agor');
      expect(result).toEqual({
        type: 'path',
        path: '/Users/max/My Projects/agor',
      });
    });

    it('should parse path with special characters', () => {
      const result = parseRepoReference('/Users/max/code/my-project_v2.0');
      expect(result).toEqual({
        type: 'path',
        path: '/Users/max/code/my-project_v2.0',
      });
    });
  });

  describe('managed repos', () => {
    it('should parse simple slug', () => {
      const result = parseRepoReference('anthropics/agor');
      expect(result).toEqual({
        type: 'managed',
        slug: 'anthropics/agor',
      });
    });

    it('should parse slug with hyphens', () => {
      const result = parseRepoReference('my-org/my-repo');
      expect(result).toEqual({
        type: 'managed',
        slug: 'my-org/my-repo',
      });
    });

    it('should parse slug with underscores', () => {
      const result = parseRepoReference('my_org/my_repo');
      expect(result).toEqual({
        type: 'managed',
        slug: 'my_org/my_repo',
      });
    });

    it('should parse slug with numbers', () => {
      const result = parseRepoReference('org123/repo456');
      expect(result).toEqual({
        type: 'managed',
        slug: 'org123/repo456',
      });
    });

    it('should parse slug with mixed case', () => {
      const result = parseRepoReference('MyOrg/MyRepo');
      expect(result).toEqual({
        type: 'managed',
        slug: 'MyOrg/MyRepo',
      });
    });
  });

  describe('managed worktree references', () => {
    it('should parse slug with worktree', () => {
      const result = parseRepoReference('anthropics/agor:main');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'anthropics/agor',
        worktree: 'main',
      });
    });

    it('should parse slug with feature branch', () => {
      const result = parseRepoReference('anthropics/agor:feat-auth');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'anthropics/agor',
        worktree: 'feat-auth',
      });
    });

    it('should parse with slash in worktree name', () => {
      const result = parseRepoReference('anthropics/agor:feature/auth');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'anthropics/agor',
        worktree: 'feature/auth',
      });
    });

    it('should parse with underscores in worktree', () => {
      const result = parseRepoReference('my-org/repo:my_branch_name');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'my-org/repo',
        worktree: 'my_branch_name',
      });
    });

    it('should split on first colon only', () => {
      const result = parseRepoReference('org/repo:branch');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'org/repo',
        worktree: 'branch',
      });
    });

    it('should handle numeric worktree names', () => {
      const result = parseRepoReference('org/repo:123');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'org/repo',
        worktree: '123',
      });
    });
  });

  describe('edge cases', () => {
    it('should not treat relative paths as absolute', () => {
      const result = parseRepoReference('org/repo');
      expect(result.type).toBe('managed');
    });

    it('should handle empty worktree name', () => {
      const result = parseRepoReference('org/repo:');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'org/repo',
        worktree: '',
      });
    });

    it('should handle single segment with colon', () => {
      const result = parseRepoReference('single:part');
      expect(result).toEqual({
        type: 'managed-worktree',
        slug: 'single',
        worktree: 'part',
      });
    });
  });
});

describe('extractSlugFromUrl', () => {
  describe('SSH URLs', () => {
    it('should extract from standard SSH URL', () => {
      const result = extractSlugFromUrl('git@github.com:anthropics/agor.git');
      expect(result).toBe('anthropics/agor');
    });

    it('should extract from SSH URL without .git', () => {
      const result = extractSlugFromUrl('git@github.com:apache/superset');
      expect(result).toBe('apache/superset');
    });

    it('should extract from GitLab SSH URL', () => {
      const result = extractSlugFromUrl('git@gitlab.com:my-group/my-project.git');
      expect(result).toBe('my-group/my-project');
    });

    it('should extract from custom SSH host', () => {
      const result = extractSlugFromUrl('git@git.example.com:company/repo.git');
      expect(result).toBe('company/repo');
    });

    it('should handle SSH with port', () => {
      const result = extractSlugFromUrl('ssh://git@github.com:22/org/repo.git');
      expect(result).toBe('org/repo');
    });
  });

  describe('HTTPS URLs', () => {
    it('should extract from HTTPS URL', () => {
      const result = extractSlugFromUrl('https://github.com/preset-io/agor.git');
      expect(result).toBe('preset-io/agor');
    });

    it('should extract from HTTPS URL without .git', () => {
      const result = extractSlugFromUrl('https://github.com/apache/superset');
      expect(result).toBe('apache/superset');
    });

    it('should extract from GitLab HTTPS URL', () => {
      const result = extractSlugFromUrl('https://gitlab.com/my-group/my-project.git');
      expect(result).toBe('my-group/my-project');
    });

    it('should extract from Bitbucket HTTPS URL', () => {
      const result = extractSlugFromUrl('https://bitbucket.org/team/repo.git');
      expect(result).toBe('team/repo');
    });

    it('should extract from custom HTTPS host', () => {
      const result = extractSlugFromUrl('https://git.internal.company.com/org/repo.git');
      expect(result).toBe('org/repo');
    });
  });

  describe('HTTP URLs', () => {
    it('should extract from HTTP URL', () => {
      const result = extractSlugFromUrl('http://github.com/org/repo.git');
      expect(result).toBe('org/repo');
    });

    it('should extract from HTTP URL without .git', () => {
      const result = extractSlugFromUrl('http://git.example.com/company/project');
      expect(result).toBe('company/project');
    });
  });

  describe('slug with special characters', () => {
    it('should handle hyphens', () => {
      const result = extractSlugFromUrl('https://github.com/my-org/my-repo.git');
      expect(result).toBe('my-org/my-repo');
    });

    it('should handle underscores', () => {
      const result = extractSlugFromUrl('https://github.com/my_org/my_repo.git');
      expect(result).toBe('my_org/my_repo');
    });

    it('should handle dots', () => {
      const result = extractSlugFromUrl('https://github.com/org.name/repo.name.git');
      expect(result).toBe('org.name/repo.name');
    });

    it('should handle numbers', () => {
      const result = extractSlugFromUrl('https://github.com/org123/repo456.git');
      expect(result).toBe('org123/repo456');
    });
  });

  describe('fallback path parsing', () => {
    it('should fallback to last two segments', () => {
      const result = extractSlugFromUrl('example.com/path/to/org/repo');
      expect(result).toBe('org/repo');
    });

    it('should handle file:// URLs', () => {
      const result = extractSlugFromUrl('file:///path/to/org/repo');
      expect(result).toBe('org/repo');
    });

    it('should throw on single segment', () => {
      expect(() => extractSlugFromUrl('single-segment')).toThrow(
        'Could not extract slug from URL: single-segment'
      );
    });

    it('should throw on empty URL', () => {
      expect(() => extractSlugFromUrl('')).toThrow('Could not extract slug from URL: ');
    });

    it('should extract from URL with trailing slash', () => {
      const result = extractSlugFromUrl('https://github.com/org/repo/');
      expect(result).toBe('org/repo');
    });
  });

  describe('.git suffix handling', () => {
    it('should remove .git from SSH', () => {
      const result = extractSlugFromUrl('git@github.com:org/repo.git');
      expect(result).toBe('org/repo');
    });

    it('should remove .git from HTTPS', () => {
      const result = extractSlugFromUrl('https://github.com/org/repo.git');
      expect(result).toBe('org/repo');
    });

    it('should handle URL without .git', () => {
      const result = extractSlugFromUrl('https://github.com/org/repo');
      expect(result).toBe('org/repo');
    });

    it('should not remove .git from middle of path', () => {
      const result = extractSlugFromUrl('https://github.com/org.git/repo.git');
      expect(result).toBe('org.git/repo');
    });
  });
});

describe('isValidSlug', () => {
  describe('valid slugs', () => {
    it('should accept simple slug', () => {
      expect(isValidSlug('anthropics/agor')).toBe(true);
    });

    it('should accept slug with hyphens', () => {
      expect(isValidSlug('my-org/my-repo')).toBe(true);
    });

    it('should accept slug with underscores', () => {
      expect(isValidSlug('my_org/my_repo')).toBe(true);
    });

    it('should accept slug with numbers', () => {
      expect(isValidSlug('org123/repo456')).toBe(true);
    });

    it('should accept mixed case', () => {
      expect(isValidSlug('MyOrg/MyRepo')).toBe(true);
    });

    it('should accept single character parts', () => {
      expect(isValidSlug('a/b')).toBe(true);
    });

    it('should accept long names', () => {
      expect(isValidSlug('very-long-organization-name/very-long-repository-name')).toBe(true);
    });

    it('should accept all hyphens', () => {
      expect(isValidSlug('---/---')).toBe(true);
    });

    it('should accept all underscores', () => {
      expect(isValidSlug('___/___')).toBe(true);
    });

    it('should accept alphanumeric mix', () => {
      expect(isValidSlug('org123_test-v2/repo_456-beta')).toBe(true);
    });

    it('should accept slugs with dots', () => {
      expect(isValidSlug('org.name/repo')).toBe(true);
      expect(isValidSlug('org/repo.name')).toBe(true);
      expect(isValidSlug('org.name/repo.name')).toBe(true);
    });

    it('should accept slugs with dots in middle', () => {
      expect(isValidSlug('my.org/my.repo')).toBe(true);
      expect(isValidSlug('org.v2/repo.beta')).toBe(true);
    });
  });

  describe('invalid slugs', () => {
    it('should reject slug without slash', () => {
      expect(isValidSlug('anthropics')).toBe(false);
    });

    it('should reject slug with multiple slashes', () => {
      expect(isValidSlug('org/sub/repo')).toBe(false);
    });

    it('should reject slug with spaces', () => {
      expect(isValidSlug('my org/my repo')).toBe(false);
    });

    it('should reject slug with special characters', () => {
      expect(isValidSlug('org@name/repo')).toBe(false);
      expect(isValidSlug('org/repo#test')).toBe(false);
      expect(isValidSlug('org$/repo')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidSlug('')).toBe(false);
    });

    it('should reject slug starting with slash', () => {
      expect(isValidSlug('/org/repo')).toBe(false);
    });

    it('should reject slug ending with slash', () => {
      expect(isValidSlug('org/repo/')).toBe(false);
    });

    it('should reject slug with only slash', () => {
      expect(isValidSlug('/')).toBe(false);
    });

    it('should reject empty org', () => {
      expect(isValidSlug('/repo')).toBe(false);
    });

    it('should reject empty repo', () => {
      expect(isValidSlug('org/')).toBe(false);
    });

    it('should reject slug with colon', () => {
      expect(isValidSlug('org/repo:branch')).toBe(false);
    });

    it('should reject slug with backslash', () => {
      expect(isValidSlug('org\\repo')).toBe(false);
    });
  });
});

describe('isValidGitUrl', () => {
  describe('valid SSH URLs', () => {
    it('should accept standard SSH URL with .git', () => {
      expect(isValidGitUrl('git@github.com:apache/superset.git')).toBe(true);
    });

    it('should accept SSH URL without .git', () => {
      expect(isValidGitUrl('git@github.com:apache/superset')).toBe(true);
    });

    it('should accept GitLab SSH URL', () => {
      expect(isValidGitUrl('git@gitlab.com:my-group/my-project.git')).toBe(true);
    });

    it('should accept SSH URL with custom host', () => {
      expect(isValidGitUrl('git@git.example.com:company/repo.git')).toBe(true);
    });

    it('should accept SSH URL with port', () => {
      expect(isValidGitUrl('git@github.com:22/org/repo.git')).toBe(true);
    });

    it('should accept ssh:// protocol format', () => {
      expect(isValidGitUrl('ssh://git@github.com/org/repo.git')).toBe(true);
    });

    it('should accept SSH URL with dots in repo name', () => {
      expect(isValidGitUrl('git@github.com:org.name/repo.name.git')).toBe(true);
    });
  });

  describe('valid HTTPS URLs', () => {
    it('should accept HTTPS URL with .git', () => {
      expect(isValidGitUrl('https://github.com/apache/superset.git')).toBe(true);
    });

    it('should accept HTTPS URL without .git', () => {
      expect(isValidGitUrl('https://github.com/apache/superset')).toBe(true);
    });

    it('should accept GitLab HTTPS URL', () => {
      expect(isValidGitUrl('https://gitlab.com/my-group/my-project.git')).toBe(true);
    });

    it('should accept Bitbucket HTTPS URL', () => {
      expect(isValidGitUrl('https://bitbucket.org/team/repo.git')).toBe(true);
    });

    it('should accept HTTP URL (insecure but valid)', () => {
      expect(isValidGitUrl('http://github.com/org/repo.git')).toBe(true);
    });

    it('should accept HTTPS with custom port', () => {
      expect(isValidGitUrl('https://git.example.com:8443/org/repo.git')).toBe(true);
    });

    it('should accept HTTPS URL with dots in repo name', () => {
      expect(isValidGitUrl('https://github.com/org.name/repo.name.git')).toBe(true);
    });

    it('should accept custom domain HTTPS URL', () => {
      expect(isValidGitUrl('https://git.internal.company.com/org/repo.git')).toBe(true);
    });
  });

  describe('invalid URLs', () => {
    it('should reject plain text', () => {
      expect(isValidGitUrl('not-a-url')).toBe(false);
    });

    it('should reject GitHub web page URL', () => {
      expect(isValidGitUrl('github.com/org/repo')).toBe(false);
    });

    it('should reject incomplete SSH URL', () => {
      expect(isValidGitUrl('git@github.com')).toBe(false);
    });

    it('should reject URL without protocol or git@', () => {
      expect(isValidGitUrl('example.com/repo')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidGitUrl('')).toBe(false);
    });

    it('should reject file:// URLs', () => {
      expect(isValidGitUrl('file:///path/to/repo')).toBe(false);
    });

    it('should reject ftp:// URLs', () => {
      expect(isValidGitUrl('ftp://example.com/repo.git')).toBe(false);
    });
  });
});

describe('formatRepoReference', () => {
  it('should format slug without worktree', () => {
    const result = formatRepoReference('anthropics/agor' as RepoSlug);
    expect(result).toBe('anthropics/agor');
  });

  it('should format slug with worktree', () => {
    const result = formatRepoReference('anthropics/agor' as RepoSlug, 'main' as WorktreeName);
    expect(result).toBe('anthropics/agor:main');
  });

  it('should format with feature branch', () => {
    const result = formatRepoReference('my-org/repo' as RepoSlug, 'feat-auth' as WorktreeName);
    expect(result).toBe('my-org/repo:feat-auth');
  });

  it('should format with slash in worktree', () => {
    const result = formatRepoReference('org/repo' as RepoSlug, 'feature/auth' as WorktreeName);
    expect(result).toBe('org/repo:feature/auth');
  });

  it('should handle undefined worktree', () => {
    const result = formatRepoReference('org/repo' as RepoSlug, undefined);
    expect(result).toBe('org/repo');
  });

  it('should handle empty string worktree as no worktree', () => {
    const result = formatRepoReference('org/repo' as RepoSlug, '' as WorktreeName);
    expect(result).toBe('org/repo');
  });

  it('should format with numeric worktree', () => {
    const result = formatRepoReference('org/repo' as RepoSlug, '123' as WorktreeName);
    expect(result).toBe('org/repo:123');
  });

  it('should format with complex worktree name', () => {
    const result = formatRepoReference(
      'org/repo' as RepoSlug,
      'feature/user-auth_v2.0' as WorktreeName
    );
    expect(result).toBe('org/repo:feature/user-auth_v2.0');
  });
});

describe('resolveRepoReference', () => {
  describe('absolute path resolution', () => {
    it('should resolve Unix path', async () => {
      const result = await resolveRepoReference('/Users/max/code/agor');
      expect(result).toEqual({
        cwd: '/Users/max/code/agor',
        managed_worktree: false,
      });
    });

    it('should resolve Windows path', async () => {
      const result = await resolveRepoReference('C:\\Users\\max\\code\\agor');
      expect(result).toEqual({
        cwd: 'C:\\Users\\max\\code\\agor',
        managed_worktree: false,
      });
    });

    it('should resolve root path', async () => {
      const result = await resolveRepoReference('/');
      expect(result).toEqual({
        cwd: '/',
        managed_worktree: false,
      });
    });

    it('should not include managed fields for paths', async () => {
      const result = await resolveRepoReference('/var/www/project');
      expect(result.repo_id).toBeUndefined();
      expect(result.repo_slug).toBeUndefined();
      expect(result.worktree_name).toBeUndefined();
      expect(result.managed_worktree).toBe(false);
    });
  });

  describe('managed repo resolution', () => {
    it('should throw for managed slug', async () => {
      await expect(resolveRepoReference('anthropics/agor')).rejects.toThrow(
        'Repository lookup not implemented in this context'
      );
    });

    it('should throw for managed worktree', async () => {
      await expect(resolveRepoReference('anthropics/agor:main')).rejects.toThrow(
        'Repository lookup not implemented in this context'
      );
    });

    it('should include parsed data in error for managed slug', async () => {
      try {
        await resolveRepoReference('org/repo');
      } catch (err) {
        expect((err as Error).message).toContain('"type":"managed"');
        expect((err as Error).message).toContain('"slug":"org/repo"');
      }
    });

    it('should include parsed data in error for managed worktree', async () => {
      try {
        await resolveRepoReference('org/repo:branch');
      } catch (err) {
        expect((err as Error).message).toContain('"type":"managed-worktree"');
        expect((err as Error).message).toContain('"slug":"org/repo"');
        expect((err as Error).message).toContain('"worktree":"branch"');
      }
    });
  });
});

describe('integration scenarios', () => {
  it('should parse and format slug consistently', () => {
    const slug = 'anthropics/agor' as RepoSlug;
    const parsed = parseRepoReference(slug);
    const formatted = formatRepoReference(parsed.slug!);
    expect(formatted).toBe(slug);
  });

  it('should parse and format worktree consistently', () => {
    const ref = 'anthropics/agor:main';
    const parsed = parseRepoReference(ref);
    const formatted = formatRepoReference(parsed.slug!, parsed.worktree);
    expect(formatted).toBe(ref);
  });

  it('should extract slug from URL and validate', () => {
    const url = 'https://github.com/preset-io/agor.git';
    const slug = extractSlugFromUrl(url);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('should parse slug from extracted URL', () => {
    const url = 'git@github.com:apache/superset.git';
    const slug = extractSlugFromUrl(url);
    const parsed = parseRepoReference(slug);
    expect(parsed.type).toBe('managed');
    expect(parsed.slug).toBe('apache/superset');
  });

  it('should handle full workflow: URL to reference string', () => {
    const url = 'https://github.com/my-org/my-repo.git';
    const slug = extractSlugFromUrl(url);
    const worktree = 'feat-auth' as WorktreeName;
    const ref = formatRepoReference(slug, worktree);
    expect(ref).toBe('my-org/my-repo:feat-auth');

    const parsed = parseRepoReference(ref);
    expect(parsed.type).toBe('managed-worktree');
    expect(parsed.slug).toBe('my-org/my-repo');
    expect(parsed.worktree).toBe('feat-auth');
  });

  it('should validate slug after URL extraction', () => {
    const validUrl = 'https://github.com/valid-org/valid-repo.git';
    const slug = extractSlugFromUrl(validUrl);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('should distinguish paths from slugs', () => {
    const pathRef = '/Users/max/code/org/repo';
    const slugRef = 'org/repo';

    const pathParsed = parseRepoReference(pathRef);
    const slugParsed = parseRepoReference(slugRef);

    expect(pathParsed.type).toBe('path');
    expect(slugParsed.type).toBe('managed');
  });
});
