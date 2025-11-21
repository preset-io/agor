#!/usr/bin/env node

import { execSync } from 'node:child_process';
import chalk from 'chalk';

const tests = [
  { name: 'whoami', cmd: 'pnpm -w agor whoami' },
  { name: 'repo list', cmd: 'pnpm -w agor repo list' },
  { name: 'mcp list', cmd: 'pnpm -w agor mcp list' },
  { name: 'user list', cmd: 'pnpm -w agor user list' },
  { name: 'worktree list', cmd: 'pnpm -w agor worktree list' },
  { name: 'session list', cmd: 'pnpm -w agor session list' },
  { name: 'board list', cmd: 'pnpm -w agor board list' },
];

let passed = 0;
let failed = 0;

console.log('');
console.log(chalk.bold.blue('═'.repeat(50)));
console.log(chalk.bold.blue('AGOR CLI COMMAND TEST SUITE'));
console.log(chalk.bold.blue('═'.repeat(50)));
console.log('');

// Check daemon health
try {
  const health = JSON.parse(execSync('curl -s http://localhost:3030/health', { encoding: 'utf8' }));
  console.log(chalk.cyan('Daemon Status:'));
  console.log(`  Version: ${health.version}`);
  console.log(`  Auth Required: ${health.auth.requireAuth}`);
  console.log(`  Allow Anonymous: ${health.auth.allowAnonymous}`);
  console.log('');
} catch {
  console.log(chalk.red('✗ Daemon not responding'));
  process.exit(1);
}

// Run tests
for (const test of tests) {
  process.stdout.write(`Testing ${chalk.cyan(test.name)}... `);

  try {
    execSync(test.cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    console.log(chalk.green('✓ PASS'));
    passed++;
  } catch (_error) {
    console.log(chalk.red('✗ FAIL'));
    failed++;
  }

  // Small delay between commands
  await new Promise(r => setTimeout(r, 200));
}

// Check for hanging processes
console.log('');
console.log(chalk.cyan('Checking for hanging processes...'));
await new Promise(r => setTimeout(r, 500));

let hangingCount = 0;
try {
  const result = execSync("pgrep -f 'tsx.*agor' | wc -l", { encoding: 'utf8' });
  hangingCount = parseInt(result.trim(), 10);
} catch {
  hangingCount = 0;
}

if (hangingCount > 0) {
  console.log(chalk.red(`✗ ${hangingCount} hanging process(es) detected`));
  failed++;
} else {
  console.log(chalk.green('✓ No hanging processes'));
  passed++;
}

// Summary
console.log('');
console.log(chalk.bold.blue('═'.repeat(50)));
console.log(chalk.bold('SUMMARY'));
console.log(chalk.bold.blue('═'.repeat(50)));
console.log(`Total: ${tests.length + 1}`);
console.log(`${chalk.green(`Passed: ${passed}`)} | ${chalk.red(`Failed: ${failed}`)}`);

if (failed === 0) {
  console.log(chalk.green.bold('\n✓ All tests passed!\n'));
  process.exit(0);
} else {
  console.log(chalk.red.bold('\n✗ Some tests failed\n'));
  process.exit(1);
}
