import { describe, expect, it } from 'vitest';
import { agorCloudReturnToProblem, isPrivateNetworkHost } from './agor-cloud';

const hostOf = (url: string) => new URL(url).hostname;

describe('Agor Cloud sign-in return URL', () => {
  it.each([
    'https://agor.example.com/ui/settings/move-to-cloud',
    'https://203.0.113.7/ui',
    'http://localhost:3030/ui',
    'http://127.0.0.1/ui',
    'http://127.12.0.9:8080/ui',
    'http://[::1]:3030/ui',
    'http://10.0.0.5/ui',
    'http://172.16.0.1/ui',
    'http://172.31.255.254/ui',
    'http://192.168.1.20:3030/ui',
    'http://[fd12:3456::1]/ui',
    'http://[fc00::1]/ui',
    'http://agor.local/ui',
    'http://agor.internal/ui',
    'http://build-box.corp.lan/ui',
    'http://agor/ui',
    'http://AGOR.LOCAL./ui',
  ])('accepts %s', (url) => {
    expect(agorCloudReturnToProblem(url)).toBeNull();
  });

  it.each([
    'http://agor.example.com/ui',
    'http://203.0.113.7/ui',
    'http://8.8.8.8/ui',
    'http://172.15.0.1/ui',
    'http://172.32.0.1/ui',
    'http://192.169.0.1/ui',
    'http://11.0.0.1/ui',
    'http://[2001:db8::1]/ui',
    'http://[fe80::1]/ui',
    'http://[::ffff:10.0.0.1]/ui',
    'http://10.0.0.1.nip.io/ui',
    'http://agor.local.example.com/ui',
    'http://0.0.0.0/ui',
    'ftp://agor.local/ui',
    'javascript:alert(1)',
    'https://user:pw@agor.example.com/ui',
    'https://agor.example.com/ui#frag',
    `https://agor.example.com/${'x'.repeat(2100)}`,
    'not a url',
  ])('rejects %s', (url) => {
    expect(agorCloudReturnToProblem(url)).not.toBeNull();
  });

  it('treats a numeric single label as the IPv4 address the URL parser makes of it', () => {
    // http://167772161 is 10.0.0.1; http://134744072 is 8.8.8.8.
    expect(isPrivateNetworkHost(hostOf('http://167772161/'))).toBe(true);
    expect(isPrivateNetworkHost(hostOf('http://134744072/'))).toBe(false);
  });
});
