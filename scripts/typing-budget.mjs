#!/usr/bin/env node
/**
 * Count TypeScript escape hatches in production source and compare them with
 * the checked-in baseline.
 *
 * Usage:
 *   pnpm typing:budget
 *   pnpm typing:budget:update
 *
 * Syntax nodes are counted with the TypeScript compiler API. Directives are
 * counted from comments because they are trivia rather than AST nodes.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BASELINE_PATH = path.join(ROOT, 'scripts/typing-budget-baseline.json');
const UPDATE = process.argv.includes('--update');

const WORKSPACES = {
  'apps/agor-cli': ['src', 'bin'],
  'apps/agor-daemon': ['src'],
  'apps/agor-docs': ['app', 'components', 'lib'],
  'apps/agor-ui': ['src'],
  'packages/client': ['src'],
  'packages/core': ['src'],
  'packages/executor': ['src', 'bin'],
  'packages/git': ['src'],
};

const CATEGORIES = [
  'explicitAny',
  'asAny',
  'doubleAssertion',
  'nonNullAssertion',
  'tsExpectError',
  'typingBiomeIgnore',
];

const SOURCE_EXTENSION = /\.(?:[cm]?ts|tsx)$/;
const EXCLUDED_DIRECTORY = /^(?:node_modules|dist|build|coverage|test|tests|__tests__|fixtures)$/;
const EXCLUDED_FILE =
  /(?:^|\.)(?:test|spec|stories|fixture|fixtures|mock|mocks)(?:\.[^.]+)?\.(?:[cm]?ts|tsx)$/;

// Biome rules whose suppression directly relaxes TypeScript typing.
const TYPING_BIOME_RULE =
  /\b(?:noExplicitAny|noNonNullAssertion|noUnsafeDeclarationMerging|useUnknownInCatchVariables|noBannedTypes)\b/;

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

function walk(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORY.test(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (
      entry.isFile() &&
      SOURCE_EXTENSION.test(entry.name) &&
      !EXCLUDED_FILE.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function unwrapParentheses(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function countFile(filePath, counts) {
  const text = readFileSync(filePath, 'utf8');
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);

  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) counts.explicitAny++;
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) counts.asAny++;

      const inner = unwrapParentheses(node.expression);
      if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
        counts.doubleAssertion++;
      }
    }
    if (ts.isNonNullExpression(node)) counts.nonNullAssertion++;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // These directive spellings are meaningful only in comments in TypeScript
  // source; line matching also handles comments not attached to an AST node.
  counts.tsExpectError += [...text.matchAll(/@ts-expect-error\b/g)].length;
  for (const match of text.matchAll(/biome-ignore[^\r\n]*/g)) {
    if (TYPING_BIOME_RULE.test(match[0])) counts.typingBiomeIgnore++;
  }
}

function collect() {
  return Object.fromEntries(
    Object.entries(WORKSPACES).map(([workspace, sourceRoots]) => {
      const counts = emptyCounts();
      for (const sourceRoot of sourceRoots) {
        for (const file of walk(path.join(ROOT, workspace, sourceRoot))) countFile(file, counts);
      }
      return [workspace, counts];
    })
  );
}

function printTable(workspaces) {
  console.table(
    Object.fromEntries(
      Object.entries(workspaces).map(([workspace, counts]) => [
        workspace,
        {
          any: counts.explicitAny,
          'as any': counts.asAny,
          'as unknown as': counts.doubleAssertion,
          '!': counts.nonNullAssertion,
          '@ts-expect-error': counts.tsExpectError,
          'biome-ignore': counts.typingBiomeIgnore,
        },
      ])
    )
  );
}

const observed = collect();
printTable(observed);

if (UPDATE) {
  const baseline = {
    $schema: './typing-budget-baseline.schema.json',
    methodology:
      'TypeScript compiler API over production TS/TSX source roots; tests, specs, fixtures, mocks, stories, and generated/build directories excluded.',
    workspaces: observed,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Updated ${path.relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
let failed = false;
for (const [workspace, counts] of Object.entries(observed)) {
  const allowed = baseline.workspaces?.[workspace];
  if (!allowed) {
    console.error(`[typing-budget] ${workspace}: missing from baseline`);
    failed = true;
    continue;
  }
  for (const category of CATEGORIES) {
    if (counts[category] > allowed[category]) {
      console.error(
        `[typing-budget] ${workspace}.${category} increased: ${counts[category]} (baseline ${allowed[category]})`
      );
      failed = true;
    } else if (counts[category] < allowed[category]) {
      console.log(
        `[typing-budget] ${workspace}.${category} improved: ${counts[category]} (baseline ${allowed[category]}); run pnpm typing:budget:update`
      );
    }
  }
}

if (failed) {
  console.error(
    '\nTyping budget exceeded. Remove the regression or deliberately update the baseline.'
  );
  process.exit(1);
}
console.log('[typing-budget] ok');
