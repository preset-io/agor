import { describe, expect, it } from 'vitest';
import { getUrlDisplayLabel, isGitHubUrl } from './Pill';

describe('getUrlDisplayLabel', () => {
  describe('GitHub URLs', () => {
    it('extracts org/repo#number for issues', () => {
      expect(getUrlDisplayLabel('https://github.com/preset-io/agor/issues/714')).toBe(
        'preset-io/agor#714'
      );
    });

    it('extracts org/repo#number for pull requests', () => {
      expect(getUrlDisplayLabel('https://github.com/preset-io/agor/pull/42')).toBe(
        'preset-io/agor#42'
      );
    });

    it('falls back to last segment for short GitHub URLs', () => {
      expect(getUrlDisplayLabel('https://github.com/preset-io/agor')).toBe('agor');
    });
  });

  describe('Shortcut URLs', () => {
    it('extracts type/id from standard story URLs', () => {
      expect(
        getUrlDisplayLabel(
          'https://app.shortcut.com/preset/story/12345/some-very-long-story-title-that-goes-on-forever'
        )
      ).toBe('story/12345');
    });

    it('extracts type/id from epic URLs', () => {
      expect(getUrlDisplayLabel('https://app.shortcut.com/myorg/epic/99/epic-title')).toBe(
        'epic/99'
      );
    });
  });

  describe('Linear URLs', () => {
    it('extracts issue ID (not the slug) from issue URLs', () => {
      expect(
        getUrlDisplayLabel('https://linear.app/myteam/issue/TEAM-123/some-long-issue-title')
      ).toBe('TEAM-123');
    });

    it('extracts issue ID without slug', () => {
      expect(getUrlDisplayLabel('https://linear.app/myteam/issue/ENG-456')).toBe('ENG-456');
    });

    it('falls back to last segment for non-issue Linear URLs', () => {
      expect(getUrlDisplayLabel('https://linear.app/myteam/project/abc')).toBe('abc');
    });
  });

  describe('Jira / Atlassian URLs', () => {
    it('extracts ticket ID from browse URLs', () => {
      expect(getUrlDisplayLabel('https://myorg.atlassian.net/browse/PROJ-123')).toBe('PROJ-123');
    });

    it('handles Jira server URLs', () => {
      expect(getUrlDisplayLabel('https://jira.mycompany.com/browse/TICKET-99')).toBe('TICKET-99');
    });
  });

  describe('unknown / generic URLs', () => {
    it('returns last path segment for unknown services', () => {
      expect(getUrlDisplayLabel('https://example.com/project/tasks/42')).toBe('42');
    });

    it('returns hostname when path is empty', () => {
      expect(getUrlDisplayLabel('https://example.com')).toBe('example.com');
    });

    it('returns hostname when path is just a slash', () => {
      expect(getUrlDisplayLabel('https://example.com/')).toBe('example.com');
    });
  });

  describe('malformed / edge-case URLs', () => {
    it('falls back to last segment of non-URL string', () => {
      expect(getUrlDisplayLabel('not-a-url/but/has/segments')).toBe('segments');
    });

    it('returns ? for empty string', () => {
      expect(getUrlDisplayLabel('')).toBe('?');
    });
  });
});

describe('isGitHubUrl', () => {
  it('returns true for github.com', () => {
    expect(isGitHubUrl('https://github.com/org/repo')).toBe(true);
  });

  it('returns true for GitHub Enterprise subdomains', () => {
    expect(isGitHubUrl('https://code.github.com/org/repo')).toBe(true);
  });

  it('returns false for github.com lookalikes', () => {
    expect(isGitHubUrl('https://github.com.evil.com/phish')).toBe(false);
  });

  it('returns false for non-GitHub URLs', () => {
    expect(isGitHubUrl('https://linear.app/team/issue/X-1')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isGitHubUrl('not-a-url')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGitHubUrl('')).toBe(false);
  });
});
