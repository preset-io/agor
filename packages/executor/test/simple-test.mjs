#!/usr/bin/env node

/**
 * Simple integration test for executor - tests ping functionality
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const socketPath = '/tmp/test-executor-simple.sock';

// Clean up
if (fs.existsSync(socketPath)) {
  fs.unlinkSync(socketPath);
}

console.log('=== Executor Simple Test ===\n');

// Start executor
console.log('1. Starting executor...');
const packageDir = new URL('..', import.meta.url).pathname;
const executor = spawn('npx', ['tsx', 'src/cli.ts', '--socket', socketPath], {
  cwd: packageDir,
});

// Capture output
let _executorOutput = '';
executor.stdout?.on('data', (data) => {
  _executorOutput += data.toString();
  process.stdout.write(`   [executor] ${data.toString()}`);
});
executor.stderr?.on('data', (data) => {
  _executorOutput += data.toString();
  process.stderr.write(`   [executor] ${data.toString()}`);
});

// Wait for socket
console.log('2. Waiting for socket...');
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Socket timeout')), 5000);
  const interval = setInterval(() => {
    if (fs.existsSync(socketPath)) {
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }
  }, 100);
});

console.log('3. Socket ready, connecting...');

// Connect
const client = net.createConnection(socketPath);
await new Promise((resolve, reject) => {
  client.on('connect', resolve);
  client.on('error', reject);
  setTimeout(() => reject(new Error('Connection timeout')), 5000);
});

console.log('4. Connected! Sending ping...');

// Send ping
const request = {
  jsonrpc: '2.0',
  id: 'test-123',
  method: 'ping',
  params: {},
};

client.write(`${JSON.stringify(request)}\n`);

// Wait for response
const response = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Response timeout')), 5000);
  client.on('data', (data) => {
    clearTimeout(timeout);
    const message = JSON.parse(data.toString());
    resolve(message);
  });
});

console.log('5. Received response:\n');
console.log(JSON.stringify(response, null, 2));

// Validate response
if (response.jsonrpc !== '2.0') {
  throw new Error('Invalid JSON-RPC version');
}

if (response.id !== 'test-123') {
  throw new Error('ID mismatch');
}

if (!response.result?.pong) {
  throw new Error('Missing pong in result');
}

if (typeof response.result.timestamp !== 'number') {
  throw new Error('Invalid timestamp');
}

console.log('\n✅ All checks passed!\n');

// Cleanup
client.end();
executor.kill('SIGTERM');

// Wait for cleanup
await new Promise((resolve) => setTimeout(resolve, 500));

console.log('Test complete!');
process.exit(0);
