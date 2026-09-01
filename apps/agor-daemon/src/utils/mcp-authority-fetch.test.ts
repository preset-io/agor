import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const authorityFetchModule = new URL('./mcp-authority-fetch.ts', import.meta.url).href;

async function runRealSDK(mode: 'current' | 'socket replacement' | 'reservation expiry') {
  // Plain Node selects the SDK's production JS exports. Vitest's development
  // conditions select eventsource-parser's published TS source, so the child
  // process is both more production-realistic and avoids mocking the SDK's
  // internal initialize -> notifications/initialized sequence.
  const probe = `
    import http from 'node:http';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    import { createAuthorityGuardedMCPFetch } from ${JSON.stringify(authorityFetchModule)};

    const mode = process.argv[1];
    const methods = [];
    let current = true;
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      let message = {};
      try { message = body ? JSON.parse(body) : {}; } catch {}
      if (message.method) methods.push(message.method);

      if (message.method === 'initialize') {
        if (mode !== 'current') {
          // Hold the real SDK's initialize response across authority loss. The
          // guarded fetch must reject the response before the SDK can dispatch
          // its initialized notification.
          await new Promise((resolve) => setTimeout(resolve, 20));
          current = false;
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'authority-test-session',
        });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'authority-test', version: '1.0.0' },
          },
        }));
        return;
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(request.method === 'DELETE' ? 200 : 404);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = new URL('http://127.0.0.1:' + address.port + '/mcp');
    const assertCurrent = () => {
      if (!current) throw new Error(mode);
    };
    const guardedFetch = createAuthorityGuardedMCPFetch(
      (input, init) => fetch(input, init),
      assertCurrent,
    );
    const transport = new StreamableHTTPClientTransport(url, { fetch: guardedFetch });
    const client = new Client({ name: 'authority-test-client', version: '1.0.0' });
    let error;
    try {
      await client.connect(transport);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      await transport.close().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
    console.log(JSON.stringify({ methods, error }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', '--input-type=module', '--eval', probe, mode],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 }
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    methods: string[];
    error?: string;
  };
}

describe('authority-guarded MCP SDK fetch', () => {
  it('allows the real SDK initialize and initialized-notification sequence while current', async () => {
    const result = await runRealSDK('current');

    expect(result.error).toBeUndefined();
    expect(result.methods.slice(0, 2)).toEqual(['initialize', 'notifications/initialized']);
  });

  it.each(['socket replacement', 'reservation expiry'] as const)(
    'blocks the real SDK initialized notification after %s during initialize',
    async (transition) => {
      const result = await runRealSDK(transition);

      expect(result.error).toContain(transition);
      expect(result.methods).toEqual(['initialize']);
    }
  );
});
