#!/usr/bin/env node
/**
 * Phase 4 Integration Test - Full End-to-End SDK Execution
 *
 * Tests the complete Phase 4 integration:
 * 1. Load config with execution.use_executor=true
 * 2. Initialize executor services (Pool, TokenService, IPCService)
 * 3. Execute SDK via executeSDK() wrapper
 * 4. Verify messages are created and broadcasted
 */

import { loadConfig } from '@agor/core/config';
import { createDatabaseAsync } from '@agor/core/db';
import { ExecutorIPCService } from '../src/services/executor-ipc-service.ts';
import { ExecutorPool } from '../src/services/executor-pool.ts';
import { executeSDK } from '../src/services/sdk-execution.ts';
import { SessionTokenService } from '../src/services/session-token-service.ts';

console.log('=== Phase 4: Full Integration Test ===\n');

// Check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY not set');
  console.warn('   This test requires an API key to execute Claude SDK');
  console.warn('   Skipping full execution test\n');
  process.exit(0);
}

try {
  // 1. Load config
  console.log('1. Loading config...');
  const config = await loadConfig();
  console.log(`   Config loaded`);
  console.log(`   use_executor: ${config.execution?.use_executor || false}\n`);

  // 2. Create database
  console.log('2. Connecting to database...');
  const DB_PATH = process.env.AGOR_DB_PATH || `${process.env.HOME}/.agor/agor.db`;
  const db = await createDatabaseAsync({ url: `file:${DB_PATH}` });
  console.log(`   Database: ${DB_PATH}\n`);

  // 3. Initialize services
  console.log('3. Initializing executor services...');

  const sessionTokenService = new SessionTokenService({
    expiration_ms: 24 * 60 * 60 * 1000,
    max_uses: -1,
  });

  // Mock app for ExecutorIPCService
  const mockApp = {
    service: (name) => {
      if (name === 'messages') {
        return {
          create: async (data) => {
            console.log(`   📨 Message: seq=${data.sequence}, type=${data.event_type}`);
            return data;
          },
        };
      }
      return null;
    },
    executorPool: null,
    sessionTokenService: null,
    executorIPCService: null,
  };

  const executorIPCService = new ExecutorIPCService(mockApp, db, sessionTokenService);
  const executorPool = new ExecutorPool(config, executorIPCService);

  // Attach to mock app
  mockApp.executorPool = executorPool;
  mockApp.sessionTokenService = sessionTokenService;
  mockApp.executorIPCService = executorIPCService;

  console.log('   ✓ Services initialized\n');

  // 4. Execute SDK
  console.log('4. Executing SDK via executeSDK wrapper...');
  console.log('   Sending "echo hello" prompt to Claude...\n');

  const result = await executeSDK(mockApp, {
    sessionId: 'test-session-phase4',
    taskId: 'test-task-phase4',
    userId: 'test-user-phase4',
    agenticTool: 'claude-code',
    prompt: 'echo "hello from phase 4"',
    cwd: process.cwd(),
    tools: [],
    permissionMode: 'bypassPermissions',
    timeoutMs: 60000,
  });

  console.log('\n5. Results:');
  console.log(`   Status: ${result.status}`);
  console.log(`   Messages: ${result.messageCount}`);
  console.log(`   Token usage:`, result.tokenUsage);

  if (result.error) {
    console.error(`   Error:`, result.error);
    throw new Error(result.error.message);
  }

  if (result.status !== 'completed') {
    throw new Error(`Expected completed status, got ${result.status}`);
  }

  console.log('\n✅ Phase 4 integration test passed!\n');
  console.log('🎉 Full executor-based SDK execution working!\n');

  // Cleanup
  await executorPool.terminateAll();
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
}
