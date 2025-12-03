#!/usr/bin/env node
/**
 * Check for unthemed Modal and message imports from antd
 *
 * This script ensures developers use our themed wrappers instead of raw Ant Design APIs.
 * Run as part of CI/pre-commit hooks.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Note: We only restrict 'message' import, not 'Modal' component
// Modal component is fine for custom modals - we only want to prevent Modal.confirm/info/etc static methods
// Those should use useThemedModal() hook instead
const RESTRICTED_IMPORTS = {
  message: {
    from: 'antd',
    message: 'Use useThemedMessage() from @/utils/message instead of importing message from antd',
    suggestion: "import { useThemedMessage } from '@/utils/message';",
  },
};

// Allowed files that can import these (the wrappers themselves)
const ALLOWED_FILES = [
  'src/utils/modal.tsx',
  'src/utils/message.tsx',
  'src/App.tsx', // Main app can import for ConfigProvider
];

async function checkFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const errors = [];

  // Check if this file is in the allowed list
  const relPath = relative(process.cwd(), filePath);
  if (ALLOWED_FILES.some((allowed) => relPath.endsWith(allowed))) {
    return errors;
  }

  // Check for restricted imports
  for (const [importName, config] of Object.entries(RESTRICTED_IMPORTS)) {
    // Match various import patterns:
    // import { message } from 'antd'
    // import { message, Button } from 'antd'
    const patterns = [
      // Named import at start: import { message, ...
      new RegExp(`import\\s*{\\s*${importName}\\s*[,}]`, 'g'),
      // Named import in middle: import { ..., message, ...
      new RegExp(`import\\s*{[^}]*,\\s*${importName}\\s*[,}]`, 'g'),
    ];

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        // Check if this import is from 'antd'
        const importLineEnd = content.indexOf('\n', match.index);
        const importLine = content.substring(match.index, importLineEnd);

        if (importLine.includes("from 'antd'") || importLine.includes('from "antd"')) {
          const lineNumber = content.substring(0, match.index).split('\n').length;
          errors.push({
            file: relPath,
            line: lineNumber,
            importName,
            message: config.message,
            suggestion: config.suggestion,
          });
        }
      }
    }
  }

  // Additionally check for Modal.confirm/info/warning/error/success usage (static methods)
  const modalStaticMethods = ['confirm', 'info', 'warning', 'error', 'success'];
  for (const method of modalStaticMethods) {
    const regex = new RegExp(`Modal\\.${method}\\s*\\(`, 'g');
    const matches = content.matchAll(regex);
    for (const match of matches) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      errors.push({
        file: relPath,
        line: lineNumber,
        importName: `Modal.${method}`,
        message: `Use useThemedModal() hook instead of Modal.${method}() static method`,
        suggestion: `const { ${method} } = useThemedModal(); // then use ${method}({ ... })`,
      });
    }
  }

  return errors;
}

function* walkSync(dir, extensions = ['.ts', '.tsx']) {
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory() && file !== 'node_modules') {
      yield* walkSync(filePath, extensions);
    } else if (stat.isFile()) {
      const ext = file.substring(file.lastIndexOf('.'));
      if (extensions.includes(ext)) {
        // Skip test and story files
        if (
          !file.endsWith('.test.ts') &&
          !file.endsWith('.test.tsx') &&
          !file.endsWith('.stories.ts') &&
          !file.endsWith('.stories.tsx')
        ) {
          yield filePath;
        }
      }
    }
  }
}

async function main() {
  console.log('🔍 Checking for unthemed Modal and message imports...\n');

  const srcDir = join(process.cwd(), 'src');
  let totalErrors = 0;
  const errorsByFile = new Map();

  for (const file of walkSync(srcDir)) {
    const errors = await checkFile(file);
    if (errors.length > 0) {
      errorsByFile.set(file, errors);
      totalErrors += errors.length;
    }
  }

  if (totalErrors === 0) {
    console.log('✅ All imports are using themed wrappers!\n');
    process.exit(0);
  }

  // Print errors
  console.error(`❌ Found ${totalErrors} unthemed import${totalErrors === 1 ? '' : 's'}:\n`);

  for (const [_file, errors] of errorsByFile) {
    for (const error of errors) {
      console.error(`  ${error.file}:${error.line}`);
      console.error(`    ❌ ${error.message}`);
      console.error(`    💡 ${error.suggestion}\n`);
    }
  }

  console.error('📚 See apps/agor-ui/THEMED_COMPONENTS.md for migration guide\n');
  process.exit(1);
}

main().catch((err) => {
  console.error('Error running check:', err);
  process.exit(1);
});
