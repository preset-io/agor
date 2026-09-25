/**
 * One predicate, because there were three answers to one question.
 *
 * The gateway's session link refused `0.0.0.0` and nothing else,
 * `gatewaySessionConnectUrl` copied that check, and the Slack connect card
 * checked nothing — so `http://localhost:3030`, the fallback a deployment that
 * never configured a public URL gets, passed all three.
 */

import { describe, expect, it } from 'vitest';
import { isBrowserReachableUrl } from './browser-reachable-url.js';

describe('isBrowserReachableUrl', () => {
  it.each([
    'https://agor.example.test',
    'https://agor.example.test/sessions/abc',
    'http://192.168.1.10:3030',
    'https://tenant-a.example.test:8443/x',
  ])('accepts %s', (url) => {
    expect(isBrowserReachableUrl(url)).toBe(true);
  });

  it.each([
    // The empty answer a hosted tenant with no durable routing gives.
    ['an uninitialised hosted tenant', ''],
    ['null', null],
    ['undefined', undefined],
    // Bind addresses, which are not destinations.
    ['the IPv4 bind address', 'http://0.0.0.0:3030'],
    ['the IPv6 bind address', 'http://[::]:3030'],
    // Loopback: the link works for exactly one person, at the daemon.
    ['the static localhost fallback', 'http://localhost:3030'],
    ['an uppercase localhost', 'http://LOCALHOST:3030'],
    ['an RFC 6761 localhost subdomain', 'http://agor.localhost:3030'],
    ['IPv4 loopback', 'http://127.0.0.1:3030'],
    ['the rest of the loopback block', 'http://127.1.2.3:3030'],
    ['IPv6 loopback', 'http://[::1]:3030'],
    // Not a URL at all, which must never reach `new URL` unguarded.
    ['a bare fragment', '#token=abc'],
    ['a relative path', '/sessions/abc'],
  ])('refuses %s', (_label, url) => {
    expect(isBrowserReachableUrl(url)).toBe(false);
  });
});
