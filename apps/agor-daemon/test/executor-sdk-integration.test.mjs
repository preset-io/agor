#!/usr/bin/env node

/**
 * Phase 3 Integration Test - SDK Execution via Executor
 *
 * Tests the complete flow:
 * 1. Daemon spawns executor
 * 2. Daemon sends execute_prompt request
 * 3. Executor requests API key
 * 4. Executor executes Claude SDK
 * 5. Executor streams events back
 */

import { ExecutorIPCService } from '../src/services/executor-ipc-service.ts';
import { ExecutorPool } from '../src/services/executor-pool.ts';
import { SessionTokenService } from '../src/services/session-token-service.ts';

console.log('=== Phase 3: SDK Execution via Executor ===\n');

// Mock database
const mockDb = {
  // Mock database interface - just enough to pass to ExecutorIPCService
  // In Phase 4, use real test database
};

// Mock Feathers app
const mockApp = {
  service: (name) => {
    if (name === 'messages') {
      return {
        create: async (data) => {
          console.log(
            `[mock:messages] Message created: seq=${data.sequence}, type=${data.event_type}`
          );
          return data;
        },
      };
    }
    return null;
  },
};

// Check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY not set - test will fail at API key request');
  console.warn('   Set it to test full SDK execution');
}

try {
  // 1. Create services
  console.log('1. Creating services...');

  const config = {
    execution: {
      run_as_unix_user: false, // No sudo required
    },
  };

  const sessionTokenService = new SessionTokenService({
    expiration_ms: 24 * 60 * 60 * 1000, // 24 hours
    max_uses: -1, // Unlimited
  });

  const ipcService = new ExecutorIPCService(mockApp, mockDb, sessionTokenService);

  const pool = new ExecutorPool(config, ipcService);

  console.log('   ✓ Services created\n');

  // 2. Spawn executor
  console.log('2. Spawning executor...');
  const executor = await pool.spawn();
  console.log(`   ✓ Executor spawned (id=${executor.id.slice(0, 8)})`);
  console.log(`   ✓ Socket: ${executor.socketPath}`);
  console.log(`   ✓ Connected: ${executor.client.isConnected()}\n`);

  // 3. Generate session token
  console.log('3. Generating session token...');
  const sessionId = 'test-session-123';
  const userId = 'test-user-456';
  const sessionToken = sessionTokenService.generateToken(sessionId, userId);
  console.log(`   ✓ Token generated: ${sessionToken.slice(0, 16)}...\n`);

  // 4. Test execute_prompt (full flow)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('4. Testing execute_prompt (Claude SDK)...');
    console.log('   Sending simple ping prompt to Claude...');

    // Track reported messages
    let messageCount = 0;
    executor.client.onNotification('report_message', (params) => {
      messageCount++;
      console.log(
        `   📨 Message ${messageCount}: type=${params.event_type}, seq=${params.sequence}`
      );
    });

    try {
      const result = await executor.client.request(
        'execute_prompt',
        {
          session_token: sessionToken,
          session_id: sessionId,
          task_id: 'test-task-789',
          agentic_tool: 'claude-code',
          prompt: 'ping',
          cwd: process.cwd(),
          tools: [],
          permission_mode: 'bypassPermissions',
          timeout_ms: 60000,
          stream: true,
        },
        120000 // 2 minute timeout
      );

      console.log(`   ✓ execute_prompt completed`);
      console.log(`   ✓ Status: ${result.status}`);
      console.log(`   ✓ Messages: ${result.message_count}`);
      console.log(`   ✓ Token usage:`, result.token_usage);

      if (result.status !== 'completed') {
        throw new Error(`Expected completed status, got ${result.status}`);
      }

      console.log('   ✓ Claude SDK execution successful\n');
    } catch (error) {
      console.error(`   ✗ execute_prompt failed:`, error.message);
      throw error;
    }
  } else {
    console.log('4. Skipping execute_prompt test (no API key)\n');
  }

  // Cleanup
  console.log('5. Cleaning up...');
  await pool.terminateAll();
  console.log('   ✓ All executors terminated\n');

  console.log('✅ Phase 3 integration test passed!\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test failed:', error);

  process.exit(1);
}
