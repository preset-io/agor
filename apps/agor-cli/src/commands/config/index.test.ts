import type { AgorConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './index';

describe('config diagnostic redaction', () => {
  it('removes every contained secret canary from default output', () => {
    const canary = 'CONFIG_SECRET_CANARY';
    const config: AgorConfig = {
      external_launch: { dev_shared_secret: canary },
      database: {
        dialect: 'postgresql',
        postgresql: {
          url: `postgresql://user:${canary}@db.example/agor?sslpassword=${canary}`,
          ssl: { ca: canary, cert: canary, key: canary },
        },
      },
      analytics: {
        plugins: [
          {
            type: 'http_batch',
            options: { url: `https://${canary}@example.test`, headers: { Authorization: canary } },
          },
        ],
      },
    };
    expect(JSON.stringify(redactSecrets(config))).not.toContain(canary);
    expect(JSON.stringify(config)).toContain(canary);
  });
});
