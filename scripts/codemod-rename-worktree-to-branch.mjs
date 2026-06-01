#!/usr/bin/env node
/**
 * Codemod: rename "Worktree" → "Branch" in **user-visible UI strings only**.
 *
 * Surgical — uses the TypeScript compiler API to walk each .ts/.tsx file
 * with a slot-aware visitor. A node sits in a "user-visible slot" if it is
 * (transitively, through transparent expressions like ternaries / `||` /
 * `??` / parens / template-expression literal parts) the value side of:
 *
 *   1. A `JsxAttribute` whose name is in `UI_LABEL_ATTRS`
 *      (`title`, `placeholder`, `label`, `tooltip`, `extra`, `copyLabel`, ...)
 *   2. A `PropertyAssignment` whose key is in `UI_LABEL_ATTRS`
 *      (catches Modal.confirm({ title: '...', content: '...' }), etc.)
 *   3. The first arg of a notification helper call in `NOTIFY_FUNCS`
 *      (`showSuccess`, `message.success`, `notification.warning`,
 *      `Modal.confirm`, ...)
 *   4. A `JsxExpression` that's a direct child of a `JsxElement` /
 *      `JsxFragment` (catches `<Tag>{x ? 'A' : 'B'}</Tag>`)
 *
 * Plus: `JsxText` (raw text between JSX tags) is always rewritten — no
 * slot wrapping needed.
 *
 * NEVER touched:
 *   - Identifiers (variables, functions, types, props, imports)
 *   - Import / export specifiers, module paths
 *   - JSX element / attribute names
 *   - JSDoc / line / block comments
 *   - The `${...}` expression parts of template literals (only the literal
 *     text segments are user-visible)
 *   - String literals that look like git CLI (`git worktree …`)
 *   - String literals that contain `worktree_id`, `worktreeId`, `/worktrees/`
 *     paths (URLs, query params, FS paths, DB column names)
 *
 * Replacement (case-preserved, longest-first so plurals win):
 *   Worktrees → Branches, Worktree → Branch
 *   worktrees → branches, worktree → branch
 *
 * Out of reach (deliberately — fix manually):
 *   - String literals stored in const-extracted maps / records
 *     (e.g. `const ACTION_LABELS = { worktree: 'Create Worktree', ... }`).
 *     Their user-visible-ness can't be detected without semantic typing.
 *   - String literals assigned to bare `const`s (e.g. `const title = ...`)
 *     even if subsequently used in a UI slot.
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
  'emptyMessage',
  'extra',
  'copyLabel',
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

// Substrings that mark a string literal as machine-facing — skip even inside a UI slot.
// (CSS class names, URL paths, DB columns, IDs, Handlebars vars referencing the
// canonical Worktree context object, etc.)
const MACHINE_MARKERS = [
  'worktree_id',
  'worktreeId',
  '/worktrees/',
  'worktrees/',
  '/worktree/',
  'agor_worktrees_',
  'git worktree', // git CLI primitive — not Agor's "branch" concept
  'git worktrees',
  '{{worktree', // Handlebars template var → canonical Worktree object (renderer-defined)
  '{{ worktree', // ditto, with whitespace
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

// Rewrite a string literal in-place using the raw source slice. Preserves
// the original escape spelling and quote character — important because
// `node.text` is the *cooked* representation (e.g. `\n` → real newline).
function rewriteStringLiteral(node, sourceFile, edits) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const raw = sourceFile.text.slice(start, end);
  if (raw.length < 2) return; // malformed
  const open = raw[0];
  const close = raw[raw.length - 1];
  const inner = raw.slice(1, -1);
  if (!shouldRewriteText(inner)) return;
  const newInner = replaceWorktreeText(inner);
  if (newInner === inner) return;
  edits.push({ start, end, newText: `${open}${newInner}${close}` });
}

// Rewrite the head + each span literal of a template expression in-place.
// Skips the `${…}` expressions — they're code, not user copy.
function rewriteTemplateExpression(node, sourceFile, edits) {
  // Head: backtick + text + `${`  →  inner is [pos+1 .. end-2)
  const head = node.head;
  const headInnerStart = head.getStart(sourceFile) + 1;
  const headInnerEnd = head.getEnd() - 2;
  const headInner = sourceFile.text.slice(headInnerStart, headInnerEnd);
  if (shouldRewriteText(headInner)) {
    const next = replaceWorktreeText(headInner);
    if (next !== headInner) {
      edits.push({ start: headInnerStart, end: headInnerEnd, newText: next });
    }
  }
  // Spans: `}text${` (middle) or `}text\`` (tail)
  for (const span of node.templateSpans) {
    const lit = span.literal;
    const isTail = lit.kind === ts.SyntaxKind.TemplateTail;
    const innerStart = lit.getStart(sourceFile) + 1;
    const innerEnd = isTail ? lit.getEnd() - 1 : lit.getEnd() - 2;
    const inner = sourceFile.text.slice(innerStart, innerEnd);
    if (shouldRewriteText(inner)) {
      const next = replaceWorktreeText(inner);
      if (next !== inner) edits.push({ start: innerStart, end: innerEnd, newText: next });
    }
  }
}

// Expressions that PASS THROUGH the user-visible-slot context to their
// children. Anything else (CallExpressions, JsxElements, ArrowFunctions,
// ObjectLiterals, comparison BinaryExpressions like `===`, …) CLOSES the
// slot — string literals in those subtrees are code, not user copy.
function isTransparentExpression(node) {
  switch (node.kind) {
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.JsxExpression: // `{ … }` wrapper inside JSX
    case ts.SyntaxKind.NonNullExpression: // `foo!`
    case ts.SyntaxKind.AsExpression: // `foo as Bar`
    case ts.SyntaxKind.TypeAssertionExpression: // `<Bar>foo`
    case ts.SyntaxKind.SatisfiesExpression: // `foo satisfies Bar`
      return true;
    case ts.SyntaxKind.BinaryExpression: {
      const op = node.operatorToken.kind;
      return (
        op === ts.SyntaxKind.BarBarToken || // ||
        op === ts.SyntaxKind.AmpersandAmpersandToken || // &&
        op === ts.SyntaxKind.QuestionQuestionToken // ??
      );
    }
    default:
      return false;
  }
}

function collectEdits(sourceFile) {
  const edits = [];

  /**
   * Walk `node` with `inSlot` telling us whether we sit inside a
   * user-visible UI slot. Slot openers set `inSlot=true` on the
   * value-side child and recurse selectively. Within an open slot,
   * only `isTransparentExpression` nodes (parens, `?:`, `||`/`&&`/`??`,
   * template-expression literal parts) propagate the slot to their
   * children — every other node kind closes it. This prevents
   * over-rewriting state-machine values, Handlebars var names, set
   * membership strings, etc. that happen to sit under a JsxExpression
   * child of JSX.
   */
  const visit = (node, inSlot) => {
    // JsxText: always rewrite, never has rewritable children.
    if (node.kind === ts.SyntaxKind.JsxText) {
      const raw = sourceFile.text.slice(node.pos, node.end);
      if (shouldRewriteText(raw)) {
        const next = replaceWorktreeText(raw);
        if (next !== raw) edits.push({ start: node.pos, end: node.end, newText: next });
      }
      return;
    }

    // In-slot string-like literals: rewrite.
    if (inSlot) {
      if (node.kind === ts.SyntaxKind.StringLiteral) {
        rewriteStringLiteral(node, sourceFile, edits);
        return;
      }
      if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        rewriteStringLiteral(node, sourceFile, edits);
        return;
      }
      if (node.kind === ts.SyntaxKind.TemplateExpression) {
        rewriteTemplateExpression(node, sourceFile, edits);
        // Descend into ${…} expressions with inSlot=false — they're code.
        for (const span of node.templateSpans) {
          visit(span.expression, false);
        }
        return;
      }
    }

    // Slot openers: open or close the slot based on local context, ignoring
    // whatever `inSlot` we inherited. Attributes and properties have their
    // own user-visibility rule (UI_LABEL_ATTRS) that overrides any
    // surrounding slot.
    if (node.kind === ts.SyntaxKind.JsxAttribute) {
      const attrName = getJsxAttributeName(node);
      const isUi = attrName != null && UI_LABEL_ATTRS.has(attrName);
      // The attribute name itself is never rewritten.
      if (node.initializer) visit(node.initializer, isUi);
      return;
    }
    if (node.kind === ts.SyntaxKind.PropertyAssignment) {
      const propName = getPropertyAssignmentName(node);
      const isUi = propName != null && UI_LABEL_ATTRS.has(propName);
      if (node.initializer) visit(node.initializer, isUi);
      return;
    }
    if (node.kind === ts.SyntaxKind.CallExpression && isNotifyCall(node)) {
      // Callee is code; only the first arg is user-visible.
      visit(node.expression, false);
      if (node.arguments[0]) visit(node.arguments[0], true);
      for (let i = 1; i < node.arguments.length; i++) visit(node.arguments[i], false);
      return;
    }
    // `<Tag>{ … }</Tag>` — the expression is JSX child content, user-visible.
    if (
      node.kind === ts.SyntaxKind.JsxExpression &&
      (node.parent?.kind === ts.SyntaxKind.JsxElement ||
        node.parent?.kind === ts.SyntaxKind.JsxFragment)
    ) {
      if (node.expression) visit(node.expression, true);
      return;
    }

    // Default: propagate `inSlot` only through transparent expressions.
    // Opaque nodes (CallExpressions, JsxElements, ArrowFunctions, …) close
    // the slot — their string-literal descendants are code.
    const childSlot = inSlot && isTransparentExpression(node);
    ts.forEachChild(node, (child) => visit(child, childSlot));
  };

  visit(sourceFile, false);
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
