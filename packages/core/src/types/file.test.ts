import { describe, expect, it } from 'vitest';
import {
  BRANCH_FILE_VIRTUAL_URL_PREFIX,
  buildBranchFileMarkdownLink,
  decodeBranchFilePath,
  encodeBranchFilePath,
  unescapeMarkdownLinkLabel,
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

  it('backslash-escapes a bracketed filename so the label survives its own Markdown boundary', () => {
    const branchId = '0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f' as Parameters<
      typeof buildBranchFileMarkdownLink
    >[0];
    const filename = 'screenshot [draft].png';
    const link = buildBranchFileMarkdownLink(branchId, `evidence/${filename}`);

    // Asserted against the exact expected string (not re-parsed out of the
    // link), so this pins the escaping behavior unambiguously: '[' and ']'
    // inside the label become '\[' and '\]'.
    expect(link).toBe(
      `[screenshot \\[draft\\].png](${BRANCH_FILE_VIRTUAL_URL_PREFIX}${branchId}/${encodeBranchFilePath(`evidence/${filename}`)})`
    );
    expect(unescapeMarkdownLinkLabel('screenshot \\[draft\\].png')).toBe(filename);
  });

  it('round-trips filenames containing backslash, [, and ] through the label grammar', () => {
    // Mirrors MarkdownRenderer's BRANCH_FILE_LABEL_PATTERN: a label token is
    // either an escaped pair ('\\.') or any character that isn't the
    // unescaped ']' that closes the label. A naive `.*?` extraction would
    // wrongly stop at an escaped ']', so the test uses the same
    // escape-aware grammar the renderer actually parses with.
    const LABEL = /^\[((?:\\.|[^\]\n\\])*)\]\(/;
    const filenames = [
      'screenshot [draft].png',
      'a[[nested]].png',
      String.raw`report\notes.txt`,
      String.raw`weird\[literal\].png`,
      // An escaped ']' immediately followed by a literal '(' in the
      // filename — the case a naive '.*?\]\(' extractor gets wrong.
      'draft](fake.png',
    ];
    for (const filename of filenames) {
      const branchId = '0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f' as Parameters<
        typeof buildBranchFileMarkdownLink
      >[0];
      const link = buildBranchFileMarkdownLink(branchId, `evidence/${filename}`);
      const [, label] = link.match(LABEL) ?? [];
      expect(label, `label for ${filename}`).toBeDefined();
      expect(unescapeMarkdownLinkLabel(label)).toBe(filename);
    }
  });
});
