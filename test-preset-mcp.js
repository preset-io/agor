#!/usr/bin/env node
/**
 * Test script to understand Preset MCP server authentication
 */

async function testPresetMCP() {
  console.log('Testing Preset MCP server authentication flow...\n');

  const mcpUrl = 'https://d8f43c1a.us1a.app-sdx.preset.io/mcp';

  // Test 1: Try connecting without authentication
  console.log('Test 1: Connecting without authentication');
  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
        id: 1,
      }),
    });

    console.log('Status:', response.status, response.statusText);
    console.log('Headers:', Object.fromEntries(response.headers.entries()));

    const text = await response.text();
    console.log('Response body:', text.substring(0, 500));
    console.log('\n');
  } catch (error) {
    console.error('Error:', error.message);
  }

  // Test 2: Check for OAuth discovery endpoints
  console.log('\nTest 2: Checking for OAuth discovery endpoints');
  const discoveryUrls = [
    'https://d8f43c1a.us1a.app-sdx.preset.io/.well-known/oauth-authorization-server',
    'https://d8f43c1a.us1a.app-sdx.preset.io/.well-known/openid-configuration',
    'https://d8f43c1a.us1a.app-sdx.preset.io/oauth/metadata',
  ];

  for (const url of discoveryUrls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        console.log(`✓ Found discovery at ${url}:`);
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`✗ ${url}: ${response.status}`);
      }
    } catch (error) {
      console.log(`✗ ${url}: ${error.message}`);
    }
  }
}

testPresetMCP().catch(console.error);
