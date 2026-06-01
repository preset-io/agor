#!/usr/bin/env node
/**
 * Sibling to `codemod-rename-worktree-to-branch.mjs`, for the user-facing
 * docs in `apps/agor-docs/pages/`. Walks each .mdx file and rewrites
 * Worktree(s)/worktree(s) → Branch(es)/branch(es) in **prose only**,
 * skipping:
 *
 *   - Fenced code blocks (```…```)
 *   - YAML / frontmatter blocks (---…---) at the top of the file
 *   - Inline code spans (`…`) — preserved verbatim
 *   - HTML/JSX import / export lines (`import X from …`)
 *   - Markdown link URLs (`](…)`) and HTML/JSX `href="…"` / `src="…"`
 *     attribute values — paths stay stable per design doc §7 ("URL
 *     paths don't change"), so `[Worktrees](/guide/worktrees)` becomes
 *     `[Branches](/guide/worktrees)`, not `[Branches](/guide/branches)`
 *   - The string `git worktree` (CLI primitive, not Agor's concept)
 *   - Substrings containing machine markers: `worktree_id`, `worktreeId`,
 *     `WorktreeID`, `/worktrees/`, `worktrees/`, `agor_worktrees_`,
 *     `{{worktree`, `{{ worktree` (Handlebars vars referencing the
 *     canonical context object)
 *
 * The tool is intentionally line-and-segment-oriented (no full Markdown
 * AST) — MDX parsing is heavy and the failure mode here is to LEAVE TEXT
 * UNCHANGED rather than overwrite something semantic. Operator can re-run
 * with `--dry` to preview.
 *
 * Usage:
 *   node scripts/codemod-rename-worktree-to-branch-mdx.mjs              # apply to apps/agor-docs/pages
 *   node scripts/codemod-rename-worktree-to-branch-mdx.mjs --dry        # preview
 *   node scripts/codemod-rename-worktree-to-branch-mdx.mjs --file <p>   # single file
 *   node scripts/codemod-rename-worktree-to-branch-mdx.mjs --root <dir> # alternate root
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const fileArgIdx = args.indexOf('--file');
const rootArgIdx = args.indexOf('--root');
const singleFile = fileArgIdx >= 0 ? args[fileArgIdx + 1] : null;
const rootDir = rootArgIdx >= 0 ? args[rootArgIdx + 1] : 'apps/agor-docs/pages';

// Word-boundary rewrite for `Worktree(s)` / `worktree(s)`. Boundaries:
//
//   - Lookbehind blocks `git ` (CLI primitive) and the identifier
//     characters `[A-Za-z0-9_{]` (catches `agor_worktrees_`, `{{worktree`,
//     `Worktree<Foo>`, `MyWorktree`).
//   - Lookahead blocks `[A-Za-z0-9_]` (catches `worktree_id`, `worktreeId`,
//     `WorktreeID`) and `.` followed by an identifier-start (catches
//     `worktree.name` template-var references). `.` followed by space /
//     end-of-line / non-identifier IS allowed (sentence terminators like
//     `… coexist with worktrees.`).
//
// URL paths (`/guide/worktrees`, `~/.agor/worktrees/`, `href="…"`,
// `src="…"`) are stashed by `preserveUrls` before this regex runs, so
// `/` boundaries aren't needed here. Fenced code blocks and inline code
// spans (`…`) are stripped at higher levels before the regex sees them.
const RENAME_RE = /(?<!git )(?<![A-Za-z0-9_{])([Ww])orktree(s?)(?![A-Za-z0-9_])(?!\.[A-Za-z_])/g;

function replaceWorktreeText(text) {
  return text.replace(RENAME_RE, (_match, firstChar, plural) => {
    const capital = firstChar === 'W';
    if (plural === 's') return capital ? 'Branches' : 'branches';
    return capital ? 'Branch' : 'branch';
  });
}

// Split a line into alternating [prose, code, prose, code, …] segments at
// backtick boundaries. Even indices are prose; odd indices are inline code
// (including the surrounding backticks, preserved verbatim).
function splitInlineCode(line) {
  const segments = [];
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick === -1) {
      segments.push(line.slice(i));
      break;
    }
    // Prose before the backtick
    segments.push(line.slice(i, tick));
    // Find matching closing backtick. Support multi-backtick inline (`` foo ``)
    // by counting the run length.
    let runLen = 1;
    while (line[tick + runLen] === '`') runLen++;
    const open = '`'.repeat(runLen);
    const closeIdx = line.indexOf(open, tick + runLen);
    if (closeIdx === -1) {
      // Unterminated — leave the rest of the line verbatim.
      segments.push(line.slice(tick));
      break;
    }
    segments.push(line.slice(tick, closeIdx + runLen));
    i = closeIdx + runLen;
  }
  return segments;
}

// Preserve URL-like substrings (Markdown link targets + JSX/HTML href/src
// values) by stashing them behind placeholders before the prose replacement
// runs, then restoring them. Keeps `[Worktrees](/guide/worktrees)` from
// becoming `[Branches](/guide/branches)` — the user-visible link text is
// rewritten while the route slug stays stable, mirroring the design doc's
// "URL paths don't change" rule.
const URL_PATTERNS = [
  /\]\(([^)]*)\)/g, // Markdown link target: ](...)
  /\bhref=("|')([^"']*)\1/g, // href="..." / href='...'
  /\bsrc=("|')([^"']*)\1/g, // src="..." / src='...'
];

// Placeholder string chosen to be (a) unlikely to appear in real MDX prose
// and (b) regex-safe (no control chars — biome rejects \x00 here).
const URL_PLACEHOLDER_PREFIX = '__AGOR_URL_PH_';
const URL_PLACEHOLDER_SUFFIX = '__';
const URL_PLACEHOLDER_RE = /__AGOR_URL_PH_(\d+)__/g;

function preserveUrls(text) {
  const stash = [];
  let next = text;
  for (const pattern of URL_PATTERNS) {
    next = next.replace(pattern, (match) => {
      const placeholder = `${URL_PLACEHOLDER_PREFIX}${stash.length}${URL_PLACEHOLDER_SUFFIX}`;
      stash.push(match);
      return placeholder;
    });
  }
  return { stashed: next, urls: stash };
}

function restoreUrls(text, urls) {
  return text.replace(URL_PLACEHOLDER_RE, (_, idx) => urls[Number(idx)]);
}

function rewriteLine(line) {
  const segments = splitInlineCode(line);
  let changed = false;
  const next = segments.map((seg, idx) => {
    // Odd indices are inline code → preserve verbatim
    if (idx % 2 === 1) return seg;
    const { stashed, urls } = preserveUrls(seg);
    const replaced = replaceWorktreeText(stashed);
    if (replaced === stashed) return seg;
    changed = true;
    return restoreUrls(replaced, urls);
  });
  return { line: next.join(''), changed };
}

function processFile(filePath) {
  const original = readFileSync(filePath, 'utf8');
  if (!/[Ww]orktree/.test(original)) return { filePath, edits: 0 };

  const lines = original.split(/(\r?\n)/); // keep line terminators
  let inFence = false;
  let fenceMarker = '';
  let inFrontmatter = false;
  let lineNumber = 0;
  let edits = 0;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const chunk = lines[i];
    // Line-terminator chunks come back as separate entries from split with
    // capture group — pass them through unchanged.
    if (/^\r?\n$/.test(chunk)) {
      out.push(chunk);
      continue;
    }
    lineNumber++;

    // Frontmatter: starts on line 1 with '---', ends with '---'. We do
    // rewrite the user-visible `title:` / `description:` values (the page
    // title in the browser tab + meta description for search results),
    // but leave other frontmatter keys / values untouched.
    if (lineNumber === 1 && chunk.trim() === '---') {
      inFrontmatter = true;
      out.push(chunk);
      continue;
    }
    if (inFrontmatter) {
      if (chunk.trim() === '---') {
        inFrontmatter = false;
        out.push(chunk);
        continue;
      }
      const frontmatterMatch = chunk.match(/^(\s*(?:title|description):\s*)(.*)$/);
      if (frontmatterMatch) {
        const [, prefix, value] = frontmatterMatch;
        const next = replaceWorktreeText(value);
        if (next !== value) edits++;
        out.push(`${prefix}${next}`);
      } else {
        out.push(chunk);
      }
      continue;
    }

    // Fenced code blocks: ```…``` or ~~~…~~~. Track the marker so a fence
    // opened with three backticks can only be closed by three backticks.
    const fenceMatch = chunk.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[2];
      } else if (chunk.trim().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      out.push(chunk);
      continue;
    }
    if (inFence) {
      out.push(chunk);
      continue;
    }

    // Skip lines that are clearly MDX module syntax (imports/exports).
    if (/^\s*(import|export)\s/.test(chunk)) {
      out.push(chunk);
      continue;
    }

    const { line: rewritten, changed } = rewriteLine(chunk);
    if (changed) edits++;
    out.push(rewritten);
  }

  const next = out.join('');
  if (next === original) return { filePath, edits: 0 };
  if (!dryRun) writeFileSync(filePath, next);
  return { filePath, edits };
}

// `blog/` is excluded by default — blog posts are dated historical content,
// not living docs. Pass `--include-blog` if you want them rewritten too.
const includeBlog = args.includes('--include-blog');
const SKIP_DIRS = new Set(
  ['node_modules', '.next', 'dist', ...(includeBlog ? [] : ['blog'])].filter(Boolean)
);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      yield full;
    }
  }
}

function main() {
  const files = singleFile
    ? [resolve(REPO_ROOT, singleFile)]
    : [...walk(resolve(REPO_ROOT, rootDir))];

  let totalEdits = 0;
  let touchedFiles = 0;
  for (const f of files) {
    const { edits } = processFile(f);
    if (edits > 0) {
      touchedFiles++;
      totalEdits += edits;
      console.log(`  ${relative(REPO_ROOT, f)}  (${edits} line${edits === 1 ? '' : 's'})`);
    }
  }

  console.log(
    `\n${dryRun ? '[dry-run] would touch' : 'Touched'} ${totalEdits} line${totalEdits === 1 ? '' : 's'} across ${touchedFiles} file${touchedFiles === 1 ? '' : 's'}.`
  );
}

main();
