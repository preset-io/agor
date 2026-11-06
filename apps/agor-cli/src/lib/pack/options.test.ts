import { describe, expect, it, vi } from 'vitest';
import { isAgorCloudHost } from './options';

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  loadConfig: vi.fn(async () => ({})),
}));

describe('isAgorCloudHost', () => {
  it('matches the Agor Cloud workspace hosts and nothing else', async () => {
    expect(await isAgorCloudHost('acme.dp-us1a.agor.cloud')).toBe(true);
    expect(await isAgorCloudHost('ACME.cloud.agor.live')).toBe(true);
    expect(await isAgorCloudHost('agor.example.com')).toBe(false);
    expect(await isAgorCloudHost('evilagor.cloud')).toBe(false);
    expect(await isAgorCloudHost('agor.cloud.example.com')).toBe(false);
  });
});
