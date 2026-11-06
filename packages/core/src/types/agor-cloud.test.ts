import { describe, expect, it } from 'vitest';
import { agorCloudReturnToProblem, isPrivateNetworkHost } from './agor-cloud';

const hostOf = (url: string) => new URL(url).hostname;

// Verbatim from preset-io/agor-cloud packages/contracts/src/self-hosted-connect.test.ts
// (318a8132): the console must agree with this install on every case.
const CONSOLE_ACCEPTED = [
  'https://agor.example.com/settings',
  'https://8.8.8.8/',
  'https://[2001:db8::1]:3030/',
  'http://localhost:3030/ui/settings',
  'http://127.0.0.1/',
  'http://127.5.6.7:8080/',
  'http://[::1]:3030/',
  'http://10.0.0.5:3030/',
  'http://172.16.0.1/',
  'http://172.31.255.255/',
  'http://192.168.1.20/ui',
  'http://[fc00::1]/',
  'http://[fd12:3456::1]:3030/',
  'http://agor.local/',
  'http://box.corp.internal:3030/',
  'http://nas.lan/',
  'http://agor:3030/',
];

const CONSOLE_REJECTED = [
  'http://agor.example.com/settings',
  'http://8.8.8.8/',
  'http://172.15.0.1/',
  'http://172.32.0.1/',
  'http://192.169.0.1/',
  'http://11.0.0.1/',
  'http://169.254.1.1/',
  'http://[2001:db8::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:10.0.0.1]/',
  'http://agor.localhost.example.com/',
  'http://agor.lan.example.com/',
  'http://localhost.:3030/',
  'https://user:pass@agor.example.com/',
  'http://user@localhost:3030/',
  'https://agor.example.com/settings#x',
  'ftp://localhost/',
  'javascript:alert(1)',
  `https://agor.example.com/${'a'.repeat(2100)}`,
];

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
    'http://AGOR.Local/ui',
    'http://10.1/ui',
    'http://167772161/ui',
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
    'http://agor.lan.example.com/ui',
    'http://localhost./ui',
    'http://agor.local./ui',
    'https://agor.example.com./ui',
    'http://169.254.169.254/ui',
    'http://[fe80::1%25eth0]/ui',
    'http://[::ffff:192.168.1.1]/ui',
    'http://-agor/ui',
    'https://exa_mple.com/ui',
    'https://agor.example.com/ui#',
    'http://0.0.0.0/ui',
    'http://134744072/ui',
    'ftp://agor.local/ui',
    'javascript:alert(1)',
    'https://user:pw@agor.example.com/ui',
    'https://agor.example.com/ui#frag',
    `https://agor.example.com/${'x'.repeat(2100)}`,
    'not a url',
  ])('rejects %s', (url) => {
    expect(agorCloudReturnToProblem(url)).not.toBeNull();
  });

  it('checks the parsed hostname: canonical IPv4 and an all-digit label as IPv4', () => {
    expect(hostOf('http://10.1/')).toBe('10.0.0.1');
    expect(isPrivateNetworkHost(hostOf('http://167772161/'))).toBe(true); // 10.0.0.1
    expect(isPrivateNetworkHost(hostOf('http://134744072/'))).toBe(false); // 8.8.8.8
    expect(isPrivateNetworkHost(hostOf('http://[::ffff:10.0.0.1]/'))).toBe(false);
    expect(isPrivateNetworkHost(hostOf('http://localhost./'))).toBe(false);
  });

  it.each(CONSOLE_ACCEPTED)('matches the console: accepts %s', (url) => {
    expect(agorCloudReturnToProblem(url)).toBeNull();
  });

  it.each(CONSOLE_REJECTED)('matches the console: rejects %s', (url) => {
    expect(agorCloudReturnToProblem(url)).not.toBeNull();
  });
});
