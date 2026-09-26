import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('MCP SDK external error integration', () => {
  it('classifies a genuine StreamableHTTPError status without retaining provider prose', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
          import { sanitizeMCPExternalError } from '../../packages/core/src/tools/mcp/external-error.ts';

          const safe = sanitizeMCPExternalError(
            new StreamableHTTPError(401, 'SENTINEL_PROVIDER_RESPONSE'),
            { stage: 'discovery' }
          );
          process.stdout.write(JSON.stringify(safe));
        `,
      ],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
      }
    );
    const safe = JSON.parse(output);

    expect(safe).toMatchObject({
      category: 'provider_rejected',
      action: 'reauthenticate',
      diagnostic: { type: 'HTTPError', status: 401 },
    });
    expect(output).not.toContain('SENTINEL');
  });
});
