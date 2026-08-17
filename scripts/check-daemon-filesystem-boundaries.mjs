#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const ENTRY = 'apps/agor-daemon/src/index.ts';
const REGISTRY = 'scripts/daemon-filesystem-exceptions.json';

// This is intentionally small and reviewable. Entries mean "calling this API can
// touch host paths/processes", not that every import of the package is forbidden.
const CAPABILITY_MANIFEST = {
  'node:fs': '*',
  fs: '*',
  'node:fs/promises': '*',
  'fs/promises': '*',
  'node:child_process': '*',
  child_process: '*',
  '@agor/core/git/exec': '*',
  '@agor/core/local-actions': '*',
  'simple-git': ['simpleGit'],
  multer: ['diskStorage'],
  express: ['static'],
  'node:fs/watch': '*',
  chokidar: ['watch'],
  glob: ['glob', 'globSync'],
};
const NON_LITERAL = '<non-literal-dynamic-import>';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function exists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
function sourceCandidate(base) {
  const stripped = base.replace(/\.[cm]?js$/, '');
  for (const file of [
    base,
    ...SOURCE_EXTENSIONS.map((x) => stripped + x),
    ...SOURCE_EXTENSIONS.map((x) => join(base, `index${x}`)),
  ]) {
    if (
      exists(file) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.includes('/node_modules/')
    )
      return resolve(file);
  }
}
function workspacePackages(root) {
  const map = new Map();
  for (const parent of ['packages', 'apps']) {
    const dir = join(root, parent);
    if (!existsDir(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgFile = join(dir, name, 'package.json');
      if (!exists(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      if (pkg.name) map.set(pkg.name, { dir: dirname(pkgFile), exports: pkg.exports ?? {} });
    }
  }
  return map;
}
function existsDir(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
function resolveWorkspace(specifier, from, packages) {
  if (specifier.startsWith('.')) return sourceCandidate(resolve(dirname(from), specifier));
  for (const [name, pkg] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
    const target = pkg.exports[subpath];
    const source = typeof target === 'string' ? target : target?.source;
    return source ? sourceCandidate(resolve(pkg.dir, source)) : undefined;
  }
}
function moduleIsCapable(source, symbol) {
  const rule = CAPABILITY_MANIFEST[source];
  return rule === '*' || (Array.isArray(rule) && rule.includes(symbol));
}
function contextName(node) {
  for (let cur = node; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name) return cur.name.getText();
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    )
      return cur.parent.name.text;
  }
  return '<module>';
}
function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function bindingsFor(sf) {
  const bindings = new Map();
  function bind(name, source, symbol) {
    bindings.set(name, { source, symbol, local: name });
  }
  function bindPattern(name, source) {
    if (ts.isIdentifier(name)) bind(name.text, source, 'default');
    else if (ts.isObjectBindingPattern(name))
      for (const el of name.elements)
        if (ts.isIdentifier(el.name))
          bind(el.name.text, source, el.propertyName?.getText(sf) ?? el.name.text);
  }
  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const source = node.moduleSpecifier.text;
      const c = node.importClause;
      if (c.name) bind(c.name.text, source, 'default');
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings))
        bind(c.namedBindings.name.text, source, '<namespace>');
      if (c.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const el of c.namedBindings.elements)
          if (!el.isTypeOnly) bind(el.name.text, source, el.propertyName?.text ?? el.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let call = node.initializer;
      if (ts.isAwaitExpression(call)) call = call.expression;
      if (
        ts.isCallExpression(call) &&
        (call.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(call.expression) && call.expression.text === 'require'))
      ) {
        const arg = call.arguments[0];
        const source = arg && ts.isStringLiteralLike(arg) ? arg.text : NON_LITERAL;
        bindPattern(node.name, source);
      } else if (ts.isIdentifier(node.name) && ts.isIdentifier(call)) {
        const original = bindings.get(call.text);
        if (original) bind(node.name.text, original.source, original.symbol);
      } else if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(call)) {
        let base = call.expression;
        while (ts.isPropertyAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base)) {
          const original = bindings.get(base.text);
          if (original)
            bind(
              node.name.text,
              original.source,
              original.symbol === '<namespace>' || original.symbol === 'default'
                ? call.name.text
                : original.symbol
            );
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        let base = call;
        while (ts.isPropertyAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base)) {
          const original = bindings.get(base.text);
          if (original)
            for (const element of node.name.elements)
              if (ts.isIdentifier(element.name))
                bind(
                  element.name.text,
                  original.source,
                  element.propertyName?.getText(sf) ?? element.name.text
                );
        }
      } else if (ts.isIdentifier(node.name) && ts.isCallExpression(call)) {
        // Higher-order wrappers such as promisify(exec), bind(exec), or a
        // project-local pass-through helper must not erase the authority of
        // the imported capability. Track the returned binding by the exact
        // imported capability; operationsFor will register the eventual use,
        // rather than broadly classifying the wrapper itself.
        for (const argument of call.arguments) {
          if (!ts.isIdentifier(argument)) continue;
          const original = bindings.get(argument.text);
          if (original) {
            bind(node.name.text, original.source, original.symbol);
            break;
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isIdentifier(node.right)
    ) {
      const original = bindings.get(node.right.text);
      if (original) bind(node.left.text, original.source, original.symbol);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return bindings;
}
function operationsFor(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = bindingsFor(sf);
  const operations = [];
  const imports = [];
  const operationCounts = new Map();
  function add(node, binding, callee, kind = 'call') {
    const base = `${kind}:${callee}@${contextName(node)}`;
    const occurrence = (operationCounts.get(base) ?? 0) + 1;
    operationCounts.set(base, occurrence);
    operations.push({
      file,
      line: lineOf(sf, node),
      import: binding.source,
      symbol: binding.symbol,
      local: binding.local,
      operation: `${base}#${occurrence}`,
    });
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg))
        add(
          node,
          { source: NON_LITERAL, symbol: '<expression>', local: '<dynamic>' },
          'dynamic-import',
          'review'
        );
      else imports.push(arg.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg))
        add(
          node,
          { source: NON_LITERAL, symbol: '<expression>', local: 'require' },
          'require',
          'review'
        );
      else imports.push(arg.text);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const b = bindings.get(node.expression.text);
        if (b && moduleIsCapable(b.source, b.symbol)) add(node, b, node.expression.text);
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        let base = node.expression.expression;
        while (ts.isPropertyAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base)) {
          const b = bindings.get(base.text);
          if (
            b &&
            moduleIsCapable(
              b.source,
              b.symbol === '<namespace>' || b.symbol === 'default'
                ? node.expression.name.text
                : b.symbol
            )
          )
            add(
              node,
              {
                ...b,
                symbol:
                  b.symbol === '<namespace>' || b.symbol === 'default'
                    ? node.expression.name.text
                    : b.symbol,
              },
              node.expression.getText(sf)
            );
        }
      }
    }
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      !node.parent?.getSourceFile().isDeclarationFile &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent) &&
      !ts.isNamespaceImport(node.parent) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const binding = bindings.get(node.text);
      if (
        binding &&
        !binding.source.startsWith('node:') &&
        !['fs', 'fs/promises', 'child_process'].includes(binding.source) &&
        moduleIsCapable(binding.source, binding.symbol)
      ) {
        add(node, binding, node.text, 'use');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { imports, operations };
}
function validateRegistry(registry, root, today) {
  const errors = [];
  const ids = new Set(),
    tuples = new Set();
  const required = [
    'id',
    'class',
    'file',
    'import',
    'symbol',
    'local',
    'operation',
    'owner',
    'boundary',
    'rationale',
    'reviewTarget',
    'reviewDate',
  ];
  for (const x of registry) {
    for (const field of required)
      if (!(field in x)) errors.push(`registry ${x.id ?? '<unknown>'}: missing ${field}`);
    if (!/^[ABCD]$/.test(x.class ?? ''))
      errors.push(`registry ${x.id}: class must be A, B, C, or D`);
    if (ids.has(x.id)) errors.push(`registry ${x.id}: duplicate stable ID`);
    ids.add(x.id);
    if (
      typeof x.file !== 'string' ||
      isAbsolute(x.file) ||
      normalize(x.file).startsWith('..') ||
      x.file.includes('\\') ||
      /[*?[\]]/.test(x.file)
    )
      errors.push(`registry ${x.id}: malformed repository-relative file path`);
    for (const field of ['import', 'symbol', 'local', 'operation'])
      if (typeof x[field] !== 'string' || !x[field] || /[*?]/.test(x[field]))
        errors.push(`registry ${x.id}: ${field} must be exact and contain no wildcard`);
    const tuple = [x.file, x.import, x.symbol, x.local, x.operation].join('\0');
    if (tuples.has(tuple)) errors.push(`registry ${x.id}: duplicate capability tuple`);
    tuples.add(tuple);
    if (x.class === 'A') {
      if (x.reviewTarget !== null && typeof x.reviewTarget !== 'string')
        errors.push(`registry ${x.id}: A reviewTarget must be text or null`);
      if (x.reviewDate !== null && !validDate(x.reviewDate))
        errors.push(`registry ${x.id}: invalid reviewDate`);
    } else {
      if (!x.owner || !x.rationale || !x.reviewTarget)
        errors.push(
          `registry ${x.id}: class ${x.class} requires owner, rationale, and reviewTarget`
        );
      if (!validDate(x.reviewDate))
        errors.push(`registry ${x.id}: class ${x.class} requires a valid reviewDate`);
      else if (x.reviewDate <= today)
        errors.push(`registry ${x.id}: transitional review date ${x.reviewDate} is expired`);
    }
  }
  return errors;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
export function checkDaemonFilesystemBoundaries({
  root = ROOT,
  entry = ENTRY,
  registryPath = REGISTRY,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const registry = JSON.parse(readFileSync(resolve(root, registryPath), 'utf8'));
  const errors = validateRegistry(registry, root, today);
  const packages = workspacePackages(root);
  const seen = new Set(),
    operations = [];
  function traverse(file) {
    if (!file || seen.has(file)) return;
    seen.add(file);
    const parsed = operationsFor(file);
    operations.push(...parsed.operations);
    for (const spec of parsed.imports) traverse(resolveWorkspace(spec, file, packages));
  }
  traverse(resolve(root, entry));
  const used = new Set();
  for (const op of operations) {
    const rel = relative(root, op.file).replaceAll('\\', '/');
    const match = registry.find(
      (x) =>
        x.file === rel &&
        x.import === op.import &&
        x.symbol === op.symbol &&
        x.local === op.local &&
        x.operation === op.operation
    );
    if (match) used.add(match.id);
    else
      errors.push(
        `${rel}:${op.line}: undeclared ${op.import}#${op.symbol} capability ${op.operation}`
      );
  }
  for (const x of registry)
    if (!used.has(x.id))
      errors.push(`registry ${x.id}: stale capability ${x.import}#${x.symbol} ${x.operation}`);
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const errors = checkDaemonFilesystemBoundaries();
  if (errors.length) {
    console.error(errors.map((x) => `[daemon-filesystem-boundaries] ${x}`).join('\n'));
    process.exit(1);
  }
  console.log('[daemon-filesystem-boundaries] ok');
}
