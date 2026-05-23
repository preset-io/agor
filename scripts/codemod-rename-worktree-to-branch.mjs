#!/usr/bin/env node
/**
 * Codemod: rename "Worktree" → "Branch" in **user-visible UI strings only**.
 *
 * Surgical — uses the TypeScript compiler API to walk each .ts/.tsx file
 * and rewrite ONLY:
 *
 *   1. JsxText nodes (text content between JSX tags)
 *   2. String / template literals passed to JSX attributes whose name is
 *      in `UI_LABEL_ATTRS` (title, placeholder, label, tooltip, ...)
 *   3. String / template literals assigned to object-literal keys in
 *      `UI_LABEL_ATTRS` (Modal.confirm({ title: '...' }), notification
 *      args, etc.). Catches `Modal.confirm`, `message.success`-style
 *      callsites by structure, not by callee name.
 *   4. String / template literals passed as the first arg of well-known
 *      notification helpers in `NOTIFY_FUNCS` (showSuccess, showError,
 *      message.success, notification.warning, ...).
 *
 * NEVER touched:
 *   - Identifiers (variables, functions, types, props, imports)
 *   - Import / export specifiers, module paths
 *   - JSX element / attribute names
 *   - JSDoc / line / block comments
 *   - String literals that look like git CLI (`git worktree …`)
 *   - String literals that contain `worktree_id`, `worktreeId`, `/worktrees/`,
 *     `worktrees/` paths (URLs, query params, FS paths, DB column names)
 *
 * Replacement (case-preserved, longest-first so plurals win):
 *   Worktrees → Branches, Worktree → Branch
 *   worktrees → branches, worktree → branch
 *
 * Usage:
 *   node scripts/codemod-rename-worktree-to-branch.mjs              # apply to apps/agor-ui/src
 *   node scripts/codemod-rename-worktree-to-branch.mjs --dry        # show diff stats only
 *   node scripts/codemod-rename-worktree-to-branch.mjs --file <p>   # single file
 *   node scripts/codemod-rename-worktree-to-branch.mjs --root <dir> # alternate root
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ----- args -----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const fileArgIdx = args.indexOf('--file');
const rootArgIdx = args.indexOf('--root');
const singleFile = fileArgIdx >= 0 ? args[fileArgIdx + 1] : null;
const rootDir = rootArgIdx >= 0 ? args[rootArgIdx + 1] : 'apps/agor-ui/src';

// JSX attribute names + object-literal keys that we treat as user-visible labels.
const UI_LABEL_ATTRS = new Set([
  'title',
  'placeholder',
  'label',
  'description',
  'tooltip',
  'helpText',
  'help',
  'message',
  'okText',
  'cancelText',
  'confirmText',
  'aria-label',
  'ariaLabel',
  'header',
  'subtitle',
  'heading',
  'caption',
  'content',
  'text',
  'tabLabel',
  'emptyText',
]);

// Notification / toast helpers — when these are CALLED, the first string-like
// arg is treated as a user-visible message. Match by simple-identifier and by
// dotted property-access (message.success, notification.warning, …).
const NOTIFY_FUNCS = new Set([
  'showSuccess',
  'showError',
  'showWarning',
  'showInfo',
  'showLoading',
  'success',
  'error',
  'warning',
  'warn',
  'info',
  'loading',
]);
const NOTIFY_RECEIVERS = new Set(['message', 'notification', 'Modal', 'toast']);

// Substrings that mark a string literal as machine-facing — skip even inside a UI_LABEL_ATTR.
// (CSS class names, URL paths, DB columns, IDs, etc.)
const MACHINE_MARKERS = [
  'worktree_id',
  'worktreeId',
  '/worktrees/',
  'worktrees/',
  '/worktree/',
  'agor_worktrees_',
  'git worktree', // git CLI primitive — not Agor's "branch" concept
  'git worktrees',
];

// case-preserving replacement
function replaceWorktreeText(text) {
  // longest match first so plurals beat singulars
  return text
    .replace(/Worktrees/g, 'Branches')
    .replace(/worktrees/g, 'branches')
    .replace(/Worktree/g, 'Branch')
    .replace(/worktree/g, 'branch');
}

function shouldRewriteText(text) {
  if (!/[Ww]orktree/.test(text)) return false;
  for (const marker of MACHINE_MARKERS) {
    if (text.includes(marker)) return false;
  }
  return true;
}

// Walk a directory and yield .ts/.tsx files (skipping node_modules, dist, etc.).
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

function getJsxAttributeName(parent) {
  if (!parent || parent.kind !== ts.SyntaxKind.JsxAttribute) return null;
  const nameNode = parent.name;
  if (!nameNode) return null;
  if (nameNode.kind === ts.SyntaxKind.Identifier) return nameNode.escapedText.toString();
  // namespaced like aria-label
  if (nameNode.text !== undefined) return nameNode.text;
  return null;
}

function getPropertyAssignmentName(parent) {
  if (!parent) return null;
  if (parent.kind !== ts.SyntaxKind.PropertyAssignment) return null;
  const nameNode = parent.name;
  if (!nameNode) return null;
  if (nameNode.kind === ts.SyntaxKind.Identifier) return nameNode.escapedText.toString();
  if (nameNode.kind === ts.SyntaxKind.StringLiteral) return nameNode.text;
  return null;
}

// Return true if this CallExpression's callee is a known notification helper.
function isNotifyCall(call) {
  if (!call || call.kind !== ts.SyntaxKind.CallExpression) return false;
  const callee = call.expression;
  // showSuccess(...)
  if (callee.kind === ts.SyntaxKind.Identifier) {
    return NOTIFY_FUNCS.has(callee.escapedText.toString());
  }
  // message.success(...), notification.warning(...), Modal.confirm(...)
  if (callee.kind === ts.SyntaxKind.PropertyAccessExpression) {
    const obj = callee.expression;
    const name = callee.name;
    if (obj?.kind === ts.SyntaxKind.Identifier && name?.kind === ts.SyntaxKind.Identifier) {
      return (
        NOTIFY_RECEIVERS.has(obj.escapedText.toString()) &&
        NOTIFY_FUNCS.has(name.escapedText.toString())
      );
    }
  }
  return false;
}

// Decide whether a string-literal-like node sits inside a user-visible slot.
function isInUiSlot(node) {
  const parent = node.parent;
  if (!parent) return false;
  // <Foo title="..." />
  if (parent.kind === ts.SyntaxKind.JsxAttribute) {
    const attrName = getJsxAttributeName(parent);
    return attrName != null && UI_LABEL_ATTRS.has(attrName);
  }
  // <Foo title={"..."} />
  if (
    parent.kind === ts.SyntaxKind.JsxExpression &&
    parent.parent?.kind === ts.SyntaxKind.JsxAttribute
  ) {
    const attrName = getJsxAttributeName(parent.parent);
    return attrName != null && UI_LABEL_ATTRS.has(attrName);
  }
  // { title: '...' }
  if (parent.kind === ts.SyntaxKind.PropertyAssignment) {
    const propName = getPropertyAssignmentName(parent);
    return propName != null && UI_LABEL_ATTRS.has(propName);
  }
  // showSuccess('...'), message.success(`...`)  — first arg of a notify call.
  if (parent.kind === ts.SyntaxKind.CallExpression && isNotifyCall(parent)) {
    return parent.arguments[0] === node;
  }
  return false;
}

function collectEdits(sourceFile) {
  // Each edit: { start, end, newText }
  const edits = [];

  const visit = (node) => {
    // 1. JsxText — raw text between JSX tags.
    //    Note: `node.text` includes leading whitespace, but `node.getStart()`
    //    skips it. We must use the raw substring (via `node.pos` / `node.end`)
    //    as both the source and the position so the rewrite is 1:1.
    if (node.kind === ts.SyntaxKind.JsxText) {
      const raw = sourceFile.text.slice(node.pos, node.end);
      if (shouldRewriteText(raw)) {
        const newText = replaceWorktreeText(raw);
        if (newText !== raw) {
          edits.push({ start: node.pos, end: node.end, newText });
        }
      }
    }
    // 2. StringLiteral in a UI slot.
    else if (node.kind === ts.SyntaxKind.StringLiteral) {
      if (isInUiSlot(node)) {
        const text = node.text;
        if (shouldRewriteText(text)) {
          const newText = replaceWorktreeText(text);
          if (newText !== text) {
            // Preserve original quotes.
            const raw = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
            const quote = raw[0];
            edits.push({
              start: node.getStart(sourceFile),
              end: node.getEnd(),
              newText: `${quote}${newText}${quote}`,
            });
          }
        }
      }
    }
    // 3. NoSubstitutionTemplateLiteral (backtick, no ${}).
    else if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      if (isInUiSlot(node)) {
        const text = node.text;
        if (shouldRewriteText(text)) {
          const newText = replaceWorktreeText(text);
          if (newText !== text) {
            edits.push({
              start: node.getStart(sourceFile),
              end: node.getEnd(),
              newText: `\`${newText}\``,
            });
          }
        }
      }
    }
    // 4. TemplateExpression (backtick with ${}) — rewrite head + each span middle/tail
    //    when the template lives in a UI slot.
    else if (node.kind === ts.SyntaxKind.TemplateExpression) {
      if (isInUiSlot(node)) {
        // head
        const head = node.head;
        if (shouldRewriteText(head.text)) {
          const newText = replaceWorktreeText(head.text);
          if (newText !== head.text) {
            // head raw text is between the opening ` and ${, i.e. starts at getStart()+1
            // and ends at getEnd()-2. We rewrite the inner text in place.
            const start = head.getStart(sourceFile) + 1;
            const end = head.getEnd() - 2;
            edits.push({ start, end, newText });
          }
        }
        // spans: middle / tail literals
        for (const span of node.templateSpans) {
          const lit = span.literal;
          if (shouldRewriteText(lit.text)) {
            const newText = replaceWorktreeText(lit.text);
            if (newText !== lit.text) {
              // middle: }text${  → inner is start+1 .. end-2
              // tail:   }text`   → inner is start+1 .. end-1
              const isTail = lit.kind === ts.SyntaxKind.TemplateTail;
              const start = lit.getStart(sourceFile) + 1;
              const end = isTail ? lit.getEnd() - 1 : lit.getEnd() - 2;
              edits.push({ start, end, newText });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edits;
}

function applyEdits(text, edits) {
  // Apply in reverse so positions stay valid.
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

function processFile(filePath) {
  const original = readFileSync(filePath, 'utf8');
  if (!/[Ww]orktree/.test(original)) return { filePath, edits: 0 };

  const sourceFile = ts.createSourceFile(
    filePath,
    original,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const edits = collectEdits(sourceFile);
  if (edits.length === 0) return { filePath, edits: 0 };

  const rewritten = applyEdits(original, edits);
  if (rewritten === original) return { filePath, edits: 0 };

  if (!dryRun) writeFileSync(filePath, rewritten);
  return { filePath, edits: edits.length };
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
      const rel = relative(REPO_ROOT, f);
      console.log(`  ${rel}  (${edits} edit${edits === 1 ? '' : 's'})`);
    }
  }

  console.log(
    `\n${dryRun ? '[dry-run] would rewrite' : 'Rewrote'} ${totalEdits} string${totalEdits === 1 ? '' : 's'} across ${touchedFiles} file${touchedFiles === 1 ? '' : 's'}.`
  );
}

main();
