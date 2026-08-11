#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, 'apps/agor-daemon/src');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || /\.(?:test|spec)\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

function isPotentialClusterBroadcast(receiver, aliases) {
  const text = receiver.getText();
  return (
    text.includes('.to(') ||
    text.includes('.in(') ||
    text.includes('.of(') ||
    text.includes('.broadcast') ||
    text === 'io' ||
    text.endsWith('.io') ||
    (ts.isIdentifier(receiver) && aliases.has(receiver.text))
  );
}

function isHaNativeBoundaryImplementation(node, file) {
  if (!file.endsWith(join('apps', 'agor-daemon', 'src', 'realtime', 'routing.ts'))) return false;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === 'emitHaNativeSocketEvent') {
      return true;
    }
  }
  return false;
}

const violations = [];
for (const file of sourceFiles(SOURCE_ROOT)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  // Resolve simple aliases so `const room = io.to(...); room.emit(...)` and
  // namespace aliases cannot bypass the boundary check. Iterate to a fixpoint
  // to cover alias chains without requiring a full TypeScript program.
  const clusterAliases = new Set(['io']);
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    function collectAliases(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isPotentialClusterBroadcast(node.initializer, clusterAliases) &&
        !node.initializer.getText().includes('.local') &&
        !clusterAliases.has(node.name.text)
      ) {
        clusterAliases.add(node.name.text);
        aliasesChanged = true;
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(source);
  }
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'emitHaNativeSocketEvent' &&
      node.arguments.length !== 4
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(
        `${relative(ROOT, file)}:${position.line + 1}:${position.character + 1} HA native emit must pass emitter, branded tenant room, event, and payload`
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'emit'
    ) {
      const receiver = node.expression.expression;
      const receiverText = receiver.getText();
      if (
        isPotentialClusterBroadcast(receiver, clusterAliases) &&
        !receiverText.includes('.local') &&
        !isHaNativeBoundaryImplementation(node, file)
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${relative(ROOT, file)}:${position.line + 1}:${position.character + 1} raw room/global Socket.IO emit must use .local or the tenant-bound emitHaNativeSocketEvent()`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (violations.length > 0) {
  console.error(`[realtime-boundaries] violations:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('[realtime-boundaries] ok');
}
