#!/usr/bin/env node
/**
 * Simple standalone test for executor pool
 * Tests daemon's ability to spawn and communicate with executors
 */

import { ExecutorPool } from '../src/services/executor-pool.ts';

console.log('=== Executor Pool Integration Test ===\n');

// Create pool with no impersonation
console.log('1. Creating ExecutorPool...');
const config = {
  execution: {
    run_as_unix_user: false, // No sudo required
  },
};

const pool = new ExecutorPool(config);
console.log('   ✓ ExecutorPool created\n');

try {
  // Test 1: Spawn executor
  console.log('2. Spawning executor...');
  const executor = await pool.spawn();
  console.log(`   ✓ Executor spawned (id=${executor.id.slice(0, 8)})`);
  console.log(`   ✓ Socket: ${executor.socketPath}`);
  console.log(`   ✓ Connected: ${executor.client.isConnected()}\n`);

  // Test 2: Send ping
  console.log('3. Sending ping request...');
  const response = await executor.client.request('ping', {});
  console.log(`   ✓ Response:`, JSON.stringify(response, null, 2));

  if (!response.pong) {
    throw new Error('Expected pong:true in response');
  }
  console.log('   ✓ Ping successful\n');

  // Test 3: Multiple sequential requests
  console.log('4. Testing multiple sequential requests...');
  for (let i = 0; i < 3; i++) {
    const res = await executor.client.request('ping', {});
    if (!res.pong) {
      throw new Error(`Ping ${i + 1} failed`);
    }
  }
  console.log('   ✓ All sequential pings successful\n');

  // Test 4: Concurrent requests
  console.log('5. Testing concurrent requests...');
  const promises = Array.from({ length: 5 }, () => executor.client.request('ping', {}));
  const responses = await Promise.all(promises);

  if (responses.length !== 5) {
    throw new Error(`Expected 5 responses, got ${responses.length}`);
  }

  if (!responses.every((r) => r.pong)) {
    throw new Error('Not all concurrent pings returned pong');
  }
  console.log('   ✓ All concurrent requests successful\n');

  // Test 5: Spawn multiple executors
  console.log('6. Testing multiple executors...');
  const executor2 = await pool.spawn();
  const executor3 = await pool.spawn();

  console.log(`   ✓ Spawned 2 more executors`);

  const multiPingPromises = [
    executor.client.request('ping', {}),
    executor2.client.request('ping', {}),
    executor3.client.request('ping', {}),
  ];

  const multiResponses = await Promise.all(multiPingPromises);

  if (multiResponses.length !== 3) {
    throw new Error(`Expected 3 responses, got ${multiResponses.length}`);
  }

  console.log('   ✓ All executors responding\n');

  // Test 6: Error handling
  console.log('7. Testing error handling...');
  try {
    await executor.client.request('unknown_method', {});
    throw new Error('Expected error for unknown method');
  } catch (error) {
    if (error.message.includes('Unknown method')) {
      console.log('   ✓ Error handling works correctly\n');
    } else {
      throw error;
    }
  }

  // Test 7: Graceful shutdown
  console.log('8. Testing graceful shutdown...');
  await pool.terminate(executor2.id);
  await pool.terminate(executor3.id);
  console.log('   ✓ Terminated 2 executors\n');

  // Test 8: Pool tracking
  console.log('9. Testing pool tracking...');
  const allExecutors = pool.getAll();
  console.log(`   ✓ Active executors: ${allExecutors.length}`);

  if (allExecutors.length !== 1) {
    throw new Error(`Expected 1 active executor, got ${allExecutors.length}`);
  }
  console.log('   ✓ Pool tracking correct\n');

  // Cleanup
  console.log('10. Cleaning up...');
  await pool.terminateAll();
  console.log('   ✓ All executors terminated\n');

  console.log('✅ All tests passed!\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test failed:', error);

  // Cleanup on error
  try {
    await pool.terminateAll();
  } catch (cleanupError) {
    console.error('Cleanup error:', cleanupError);
  }

  process.exit(1);
}
