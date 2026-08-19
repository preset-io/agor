import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPENCODE_INTEGRATION } from './index.js';

describe('OpenCode integration metadata', () => {
  it('reports the exact SDK version installed by the package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { devDependencies: Record<string, string> };

    expect(OPENCODE_INTEGRATION.sdkVersion).toBe(
      `@opencode-ai/sdk@${manifest.devDependencies['@opencode-ai/sdk']}`
    );
  });
});
