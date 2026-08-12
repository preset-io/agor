#!/usr/bin/env node
/**
 * Regression guard: forbid re-declaring the message streaming event family.
 *
 * The canonical runtime values live in STREAMING_EVENT_TYPES. This check reads
 * that declaration, then uses the TypeScript AST to find call-site unions,
 * arrays/Sets, and logical-OR equality chains that re-list two or more members.
 * Individual type-narrowing comparisons remain valid.
 *
 * Per-construct escape hatch:
 *   // magic-string-guard:ignore <why this declaration has a separate owner>
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGETS = ['apps/agor-daemon/src'];
const CANONICAL_FILE = 'packages/core/src/types/message.ts';
const CANONICAL_NAME = 'STREAMING_EVENT_TYPES';
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache']);
const PRAGMA = 'magic-string-guard:ignore';

function sourceFile(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function declaredArrays(source) {
  const declarations = new Map();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrayLiteralExpression(unwrapExpression(node.initializer))
    ) {
      declarations.set(node.name.text, unwrapExpression(node.initializer));
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return declarations;
}

function resolveStringArray(name, declarations, resolving = new Set()) {
  if (resolving.has(name)) throw new Error(`Circular canonical array spread through ${name}`);
  const declaration = declarations.get(name);
  if (!declaration) throw new Error(`Canonical array ${name} was not found`);

  resolving.add(name);
  const values = [];
  for (const element of declaration.elements) {
    if (ts.isStringLiteralLike(element)) {
      values.push(element.text);
    } else if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      values.push(...resolveStringArray(element.expression.text, declarations, resolving));
    } else {
      throw new Error(
        `Canonical array ${name} must contain only string literals or named array spreads`
      );
    }
  }
  resolving.delete(name);
  return values;
}

async function canonicalEvents(root, canonicalFile, canonicalName) {
  const file = path.join(root, canonicalFile);
  const text = await fs.readFile(file, 'utf8');
  const values = resolveStringArray(canonicalName, declaredArrays(sourceFile(file, text)));
  if (new Set(values).size !== values.length) {
    throw new Error(`Canonical array ${canonicalName} contains duplicate values`);
  }
  if (values.length < 2) throw new Error(`Canonical array ${canonicalName} must contain a family`);
  return new Set(values);
}

function directStringEvents(nodes, canonical) {
  return nodes
    .map(unwrapExpression)
    .filter(ts.isStringLiteralLike)
    .map((node) => node.text)
    .filter((value) => canonical.has(value));
}

function unionEvents(node, canonical) {
  return node.types
    .filter(ts.isLiteralTypeNode)
    .map((type) => type.literal)
    .filter(ts.isStringLiteralLike)
    .map((literal) => literal.text)
    .filter((value) => canonical.has(value));
}

function isLogicalOr(node) {
  const expression = unwrapExpression(node);
  return (
    ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  );
}

function logicalOrParent(node) {
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent ? isLogicalOr(parent) : false;
}

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function comparisonEvents(node, canonical) {
  const expression = unwrapExpression(node);
  if (!ts.isBinaryExpression(expression)) return [];
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...comparisonEvents(expression.left, canonical),
      ...comparisonEvents(expression.right, canonical),
    ];
  }
  if (!EQUALITY_OPERATORS.has(expression.operatorToken.kind)) return [];
  return directStringEvents(
    [unwrapExpression(expression.left), unwrapExpression(expression.right)],
    canonical
  );
}

function uniqueFamily(events) {
  return [...new Set(events)].sort();
}

function containingConstruct(node) {
  let current = node;
  while (
    current.parent &&
    !ts.isStatement(current) &&
    !ts.isTypeAliasDeclaration(current) &&
    !ts.isPropertySignature(current) &&
    !ts.isParameter(current)
  ) {
    current = current.parent;
  }
  return current;
}

function pragmaDisposition(lines, source, node) {
  const nodeLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const construct = containingConstruct(node);
  const constructLine = source.getLineAndCharacterOfPosition(construct.getStart(source)).line;
  const candidates = new Set([nodeLine, nodeLine - 1, constructLine, constructLine - 1]);

  for (const lineNumber of candidates) {
    if (lineNumber < 0) continue;
    const line = lines[lineNumber] ?? '';
    const index = line.indexOf(PRAGMA);
    if (index === -1) continue;
    const reason = line
      .slice(index + PRAGMA.length)
      .replace(/\*\/.*$/, '')
      .trim();
    return reason ? 'ignored' : 'missing-reason';
  }
  return 'none';
}

function scanSource(file, text, canonical) {
  const source = sourceFile(file, text);
  const lines = text.split('\n');
  const violations = [];

  function record(node, kind, events) {
    const family = uniqueFamily(events);
    if (family.length < 2) return;
    const pragma = pragmaDisposition(lines, source, node);
    if (pragma === 'ignored') return;
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const detail =
      pragma === 'missing-reason'
        ? `${PRAGMA} requires a reason`
        : `re-lists ${family.map((value) => JSON.stringify(value)).join(', ')}`;
    violations.push(`${file}:${line + 1}:${character + 1}: ${kind} ${detail}`);
  }

  function visit(node) {
    if (ts.isUnionTypeNode(node)) record(node, 'union', unionEvents(node, canonical));
    if (ts.isArrayLiteralExpression(node)) {
      record(node, 'array', directStringEvents([...node.elements], canonical));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      !logicalOrParent(node)
    ) {
      record(node, 'equality chain', comparisonEvents(node, canonical));
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function dirExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function checkMagicStringDrift({
  root = ROOT,
  targets = TARGETS,
  canonicalFile = CANONICAL_FILE,
  canonicalName = CANONICAL_NAME,
} = {}) {
  const canonical = await canonicalEvents(root, canonicalFile, canonicalName);
  const violations = [];

  for (const target of targets) {
    const absoluteTarget = path.join(root, target);
    if (!(await dirExists(absoluteTarget))) continue;
    for await (const file of walk(absoluteTarget)) {
      const text = await fs.readFile(file, 'utf8');
      violations.push(...scanSource(path.relative(root, file), text, canonical));
    }
  }

  return violations;
}

async function main() {
  const violations = await checkMagicStringDrift();
  if (violations.length > 0) {
    console.error(`${violations.join('\n')}\n`);
    console.error(
      `❌ ${violations.length} streaming-event declaration${violations.length === 1 ? '' : 's'} must use ` +
        '`STREAMING_EVENT_TYPES`, its derived type, or a shared subset.\n' +
        'See `context/guidelines/constants.md`.'
    );
    process.exitCode = 1;
    return;
  }
  console.log('✅ No re-listed streaming event families found.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
