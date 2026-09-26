import { appendFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'offline-fixture', version: '1.0.0' });
for (const name of ['edit_file', 'excluded']) {
  server.registerTool(
    name,
    { description: 'Offline contract fixture', inputSchema: { file_path: z.string() } },
    async () => {
      await appendFile(process.argv[2], 'executed\n');
      return { content: [{ type: 'text', text: 'fixture result' }] };
    }
  );
}
await server.connect(new StdioServerTransport());
