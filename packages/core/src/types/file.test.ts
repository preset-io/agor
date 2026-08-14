import { describe, expect, it } from 'vitest';
import {
  BRANCH_FILE_VIRTUAL_URL_PREFIX,
  buildBranchFileMarkdownLink,
  decodeBranchFilePath,
  encodeBranchFilePath,
} from './file';

describe('branch file virtual Markdown links', () => {
  it('round-trips branch-relative paths, including parens and unicode', () => {
    const paths = [
      'README.md',
      'src/screenshots/before (final).png',
      'docs/résumé notes.webm',
      'a/b/c.d.e',
    ];
    for (const path of paths) {
      expect(decodeBranchFilePath(encodeBranchFilePath(path))).toBe(path);
    }
  });

  it('never leaves an unescaped paren that could close a Markdown link early', () => {
    expect(encodeBranchFilePath('shots/before (final).png')).not.toMatch(/[()]/);
  });

  it('builds a closed virtual link naming the branch and encoded path', () => {
    const branchId = '0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f' as Parameters<
      typeof buildBranchFileMarkdownLink
    >[0];
    const link = buildBranchFileMarkdownLink(branchId, 'evidence/screenshot (1).png');

    expect(link).toBe(
      `[screenshot (1).png](${BRANCH_FILE_VIRTUAL_URL_PREFIX}${branchId}/${encodeBranchFilePath('evidence/screenshot (1).png')})`
    );
    const [, encodedPath] = link.match(/\/([^/]+)\)$/) ?? [];
    expect(decodeBranchFilePath(encodedPath)).toBe('evidence/screenshot (1).png');
  });

  it('falls back to the last path segment as filename when no display name is given', () => {
    const branchId = '0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f' as Parameters<
      typeof buildBranchFileMarkdownLink
    >[0];
    expect(buildBranchFileMarkdownLink(branchId, 'a/b/report.txt')).toContain('[report.txt]');
  });
});
