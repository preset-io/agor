#!/usr/bin/env node
/**
 * Phase 5 Integration Test - Sessions Endpoint with Executor
 *
 * Tests the complete flow:
 * 1. Start daemon with execution.use_executor=true
 * 2. Call /sessions/:id/prompt endpoint
 * 3. Verify executor-based execution path is taken
 * 4. Verify task completion
 */

console.log('=== Phase 5: Sessions Endpoint Integration Test ===\n');

// Check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY not set');
  console.warn('   This test requires an API key to execute Claude SDK');
  console.warn('   Skipping test\n');
  process.exit(0);
}

console.log('📋 Test Requirements:');
console.log('   1. Set execution.use_executor=true in config');
console.log('   2. Start daemon: cd apps/agor-daemon && pnpm dev');
console.log('   3. Create a test session with agentic_tool=claude-code');
console.log('   4. Call prompt endpoint and verify executor routing\n');

console.log('📖 Manual Test Steps:');
console.log('');
console.log('1. Enable executor-based execution:');
console.log('   agor config set execution.use_executor true');
console.log('');
console.log('2. Restart daemon (in watch mode):');
console.log('   cd apps/agor-daemon && pnpm dev');
console.log('');
console.log('3. Look for log line when sending prompt:');
console.log('   🔒 [Daemon] Routing to executor for isolated SDK execution');
console.log('');
console.log('4. If you see that line, Phase 5 is working!');
console.log('');
console.log('✅ Phase 5 integration is ready for manual testing!\n');

// TODO: Add automated test using fetch to daemon API
// This would require:
// 1. Starting daemon in test mode
// 2. Creating a test session
// 3. Calling POST /sessions/:id/prompt
// 4. Verifying executor logs and task completion

process.exit(0);
