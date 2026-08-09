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

function isPotentialClusterBroadcast(receiver) {
  const text = receiver.getText();
  return (
    text.includes('.to(') || text.includes('.broadcast') || text === 'io' || text.endsWith('.io')
  );
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
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'emit'
    ) {
      const receiver = node.expression.expression;
      const receiverText = receiver.getText();
      if (isPotentialClusterBroadcast(receiver) && !receiverText.includes('.local')) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${relative(ROOT, file)}:${position.line + 1}:${position.character + 1} raw room/global Socket.IO emit must use .local or emitHaNativeSocketEvent()`
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
