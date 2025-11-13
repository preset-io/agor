#!/usr/bin/env node

/**
 * Agor MCP STDIO ⇄ HTTP Bridge
 *
 * Allows STDIO-only MCP clients (e.g., Codex) to connect to Agor's HTTP MCP endpoint.
 *
 * Usage example (MCP server config):
 *   command = "node"
 *   args = ["./scripts/agor-mcp-stdio-bridge.js", "--session-token", "<token>"]
 *
 * Optional flags:
 *   --url            Override MCP HTTP endpoint (default: http://localhost:3030/mcp)
 *   --session-token  Explicit session token (falls back to AGOR_MCP_SESSION_TOKEN env var)
 *
 * The script speaks the MCP STDIO protocol (Content-Length headers) and forwards
 * each JSON-RPC request to the HTTP endpoint, relaying the response back over STDIO.
 */

import { Buffer } from 'node:buffer';
import { argv, exit, stdin, stdout } from 'node:process';

const DEFAULT_MCP_URL = 'http://localhost:3030/mcp';

function parseArgs() {
  const args = argv.slice(2);
  let url = process.env.AGOR_MCP_HTTP_URL || DEFAULT_MCP_URL;
  let sessionToken = process.env.AGOR_MCP_SESSION_TOKEN;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') {
      const value = args[i + 1];
      if (!value) {
        console.error('❌ [agor-mcp-bridge] Missing value for --url flag');
        exit(1);
      }
      url = value;
      i += 1;
    } else if (arg === '--session-token') {
      const value = args[i + 1];
      if (!value) {
        console.error('❌ [agor-mcp-bridge] Missing value for --session-token flag');
        exit(1);
      }
      sessionToken = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.error(`Agor MCP STDIO Bridge

Usage:
  node scripts/agor-mcp-stdio-bridge.js [--url <http://host:port/mcp>] --session-token <token>

Flags:
  --url            MCP HTTP endpoint (default: ${DEFAULT_MCP_URL})
  --session-token  Session token for authentication (required unless AGOR_MCP_SESSION_TOKEN is set)

Environment:
  AGOR_MCP_HTTP_URL       Override default MCP endpoint
  AGOR_MCP_SESSION_TOKEN  Provide session token without CLI flag
`);
      exit(0);
    }
  }

  if (!sessionToken) {
    console.error(
      '❌ [agor-mcp-bridge] Session token is required. Pass --session-token or set AGOR_MCP_SESSION_TOKEN.'
    );
    exit(1);
  }

  return { url, sessionToken };
}

const { url: mcpUrl, sessionToken } = parseArgs();

// Ensure MCP URL has sessionToken query param
const urlWithToken = new URL(mcpUrl);
if (!urlWithToken.searchParams.has('sessionToken')) {
  urlWithToken.searchParams.set('sessionToken', sessionToken);
}

let stdinBuffer = Buffer.alloc(0);
const messageQueue = [];
let processing = false;

stdin.setEncoding('binary');
stdin.on('data', chunk => {
  stdinBuffer = Buffer.concat([stdinBuffer, Buffer.from(chunk, 'binary')]);
  processBuffer();
});

stdin.on('end', () => {
  if (stdinBuffer.length > 0) {
    processBuffer();
  }
});

function processBuffer() {
  while (true) {
    const headerEnd = findHeaderTerminator(stdinBuffer);
    if (headerEnd === -1) {
      break;
    }

    const header = stdinBuffer.slice(0, headerEnd).toString('utf8');
    const contentLength = parseContentLength(header);
    if (contentLength === null) {
      console.error('⚠️  [agor-mcp-bridge] Invalid Content-Length header, dropping message');
      stdinBuffer = stdinBuffer.slice(headerEnd + 4);
      continue;
    }

    const totalLength = headerEnd + 4 + contentLength;
    if (stdinBuffer.length < totalLength) {
      break;
    }

    const bodyBuffer = stdinBuffer.slice(headerEnd + 4, totalLength);
    stdinBuffer = stdinBuffer.slice(totalLength);

    try {
      const message = JSON.parse(bodyBuffer.toString('utf8'));
      messageQueue.push(message);
    } catch (error) {
      console.error('⚠️  [agor-mcp-bridge] Failed to parse MCP request JSON:', error);
    }
  }

  if (!processing) {
    processQueue();
  }
}

function findHeaderTerminator(buffer) {
  let index = buffer.indexOf('\r\n\r\n');
  if (index !== -1) {
    return index;
  }
  index = buffer.indexOf('\n\n');
  if (index !== -1) {
    return index;
  }
  return -1;
}

function parseContentLength(header) {
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number.parseInt(match[1], 10);
  return Number.isNaN(length) ? null : length;
}

async function processQueue() {
  processing = true;

  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    await handleMessage(message);
  }

  processing = false;
}

async function handleMessage(message) {
  try {
    const response = await fetch(urlWithToken, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!text) {
      // No response body (notification); respect JSON-RPC spec by not responding unless ID exists.
      return;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${(error && error.message) || error}`);
    }

    if (message.id !== undefined) {
      writeMessage(payload);
    }
  } catch (error) {
    console.error('❌ [agor-mcp-bridge] Request failed:', error);
    if (message.id !== undefined) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32099,
          message: 'Agor MCP bridge error',
          data: {
            detail: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(header);
  stdout.write(body);
}
