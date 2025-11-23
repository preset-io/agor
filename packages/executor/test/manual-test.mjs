/**
 * Manual test script for executor
 * Run this to test the executor manually without needing compilation
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const socketPath = '/tmp/test-executor-manual.sock';

// Clean up
if (fs.existsSync(socketPath)) {
  fs.unlinkSync(socketPath);
}

console.log('Starting manual executor test...\n');

// Start executor (using tsx to run TypeScript directly)
console.log('1. Spawning executor process...');
const executor = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: '/home/agor/.agor/worktrees/preset-io/agor/agor-unix-user/packages/executor',
  stdio: 'inherit',
  env: { ...process.env, SOCKET_PATH: socketPath },
});

// Wait for socket to exist
await new Promise((resolve) => {
  const interval = setInterval(() => {
    if (fs.existsSync(socketPath)) {
      clearInterval(interval);
      resolve();
    }
  }, 100);
});

console.log('\n2. Executor started, socket ready');

// Connect to executor
console.log('3. Connecting to executor...');
const client = net.createConnection(socketPath);

await new Promise((resolve) => {
  client.on('connect', resolve);
});

console.log('4. Connected! Sending ping request...');

// Send ping request
const request = {
  jsonrpc: '2.0',
  id: 'test-1',
  method: 'ping',
  params: {},
};

client.write(`${JSON.stringify(request)}\n`);

// Wait for response
const response = await new Promise((resolve) => {
  client.on('data', (data) => {
    const message = JSON.parse(data.toString());
    resolve(message);
  });
});

console.log('5. Received response:');
console.log(JSON.stringify(response, null, 2));

// Cleanup
client.end();
executor.kill('SIGTERM');

// Wait a bit for cleanup
await new Promise((resolve) => setTimeout(resolve, 500));

console.log('\n✅ Test passed!');
process.exit(0);
