import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function createGeminiMcpFixture(onCall) {
  const server = new McpServer({ name: 'gemini-fixture', version: '1.0.0' });
  for (const name of ['edit_file', 'excluded', 'smoke_ping']) {
    server.registerTool(
      name,
      { description: 'Offline contract fixture', inputSchema: { file_path: z.string() } },
      async () => {
        await onCall();
        return { content: [{ type: 'text', text: 'fixture result' }] };
      }
    );
  }
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createGeminiMcpFixture(() => appendFile(process.argv[2], 'executed\n')).connect(
    new StdioServerTransport()
  );
}
