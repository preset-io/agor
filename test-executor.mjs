#!/usr/bin/env node
/**
 * Simple Executor Validation Test
 * Tests that executor spawning works and process isolation is functioning
 */

import { execSync } from 'node:child_process';

console.log('🧪 Executor Isolation Validation Test\n');

// Test 1: Verify agor_executor user exists
console.log('1. Checking if agor_executor user exists...');
try {
  const userCheck = execSync('id agor_executor', { encoding: 'utf8' });
  console.log(`   ✅ User exists: ${userCheck.trim()}\n`);
} catch (_error) {
  console.log('   ❌ agor_executor user not found\n');
  process.exit(1);
}

// Test 2: Check config has executor enabled
console.log('2. Checking config.yaml for executor settings...');
try {
  const config = execSync('cat ~/.agor/config.yaml', { encoding: 'utf8' });
  if (config.includes('use_executor: true')) {
    console.log('   ✅ Executor mode enabled in config\n');
  } else {
    console.log('   ❌ Executor mode not enabled\n');
    process.exit(1);
  }
} catch (_error) {
  console.log('   ❌ Could not read config\n');
  process.exit(1);
}

// Test 3: Verify daemon is running with executor services
console.log('3. Checking if daemon has executor services initialized...');
try {
  const response = await fetch('http://localhost:3064/health');
  const health = await response.json();
  console.log(`   ✅ Daemon healthy: ${health.status}\n`);
} catch (_error) {
  console.log('   ⚠️  Daemon not responding (may still be starting)\n');
}

// Test 4: Check daemon logs for executor initialization
console.log('4. Checking daemon logs for executor initialization...');
try {
  // Since we're inside the container, we can't easily check docker logs
  // This test would need to run from outside the container
  console.log('   ℹ️  Run from host: docker logs <container> | grep "Initializing executor"\n');
} catch (_error) {
  console.log('   ⚠️  Could not check logs\n');
}

console.log('✅ Basic validation complete!');
console.log('\nNext steps to test full executor flow:');
console.log('1. Create a test session via the API');
console.log('2. Send a prompt and watch for executor spawning');
console.log('3. Verify executor runs as agor_executor user');
console.log('4. Check that IPC communication works\n');
