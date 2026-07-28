/**
 * `isPublicHttpUrl` is the outbound-request filter for URLs that arrive from
 * outside Agor — today the MCP catalog's auth probe, which follows endpoints
 * anyone can publish to a public registry. Every case below is a spelling of an
 * address that reaches the daemon's own network.
 */

import { describe, expect, it } from 'vitest';
import { isAllowedHealthCheckUrl, isPublicHttpUrl } from './url';

describe('isPublicHttpUrl', () => {
  it.each([
    'https://example.com/mcp',
    'http://example.com:8080/mcp',
    'https://sub.domain.example.co.uk/path?q=1',
    'https://8.8.8.8/mcp',
    'https://[2606:4700:4700::1111]/mcp',
    // Real hostnames that merely begin with the IPv6 unique-local prefixes.
    'https://fdn.example.com/mcp',
    'https://fc-cdn.net/mcp',
    'https://fe80s.example.com/mcp',
  ])('allows %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(true);
  });

  it.each([
    ['http://localhost/mcp', 'localhost'],
    ['http://app.localhost/mcp', 'localhost subdomain'],
    ['http://127.0.0.1/mcp', 'loopback'],
    ['http://127.255.255.254/mcp', 'loopback range'],
    ['http://0.0.0.0/mcp', 'this network'],
    ['http://10.0.0.1/mcp', 'RFC 1918 /8'],
    ['http://172.16.0.1/mcp', 'RFC 1918 /12 lower bound'],
    ['http://172.31.255.255/mcp', 'RFC 1918 /12 upper bound'],
    ['http://192.168.1.1/mcp', 'RFC 1918 /16'],
    ['http://169.254.169.254/mcp', 'AWS/Azure metadata'],
    ['http://100.64.0.1/mcp', 'CGNAT'],
    ['http://224.0.0.1/mcp', 'multicast'],
    ['http://255.255.255.255/mcp', 'broadcast'],
    ['http://metadata.google.internal/mcp', 'GCP metadata'],
    ['http://[::1]/mcp', 'IPv6 loopback'],
    ['http://[::]/mcp', 'IPv6 unspecified'],
    ['http://[fe80::1]/mcp', 'IPv6 link-local'],
    ['http://[fd00:ec2::254]/mcp', 'AWS IPv6 metadata'],
    ['http://[fc00::1]/mcp', 'IPv6 unique-local'],
    ['http://[::ffff:127.0.0.1]/mcp', 'IPv4-mapped loopback'],
    ['http://[::ffff:10.0.0.1]/mcp', 'IPv4-mapped RFC 1918'],
    ['ftp://example.com/mcp', 'non-http scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['https://user:pass@example.com/mcp', 'embedded credentials'],
    ['not a url', 'unparseable'],
    ['', 'empty'],
  ])('refuses %s (%s)', (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  it.each([
    ['http://2130706433/mcp', 'decimal loopback'],
    ['http://0x7f000001/mcp', 'hex loopback'],
    ['http://017700000001/mcp', 'octal loopback'],
    ['http://127.1/mcp', 'short-form loopback'],
    ['http://0xa.0x0.0x0.0x1/mcp', 'hex-per-octet RFC 1918'],
    ['http://192.168.257/mcp', 'short-form RFC 1918'],
  ])('refuses %s (%s), which spells a private address unconventionally', (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  it('is strictly stronger than the health-check filter it sits beside', () => {
    // A health check legitimately targets a branch's local dev server, so the
    // two filters must not be collapsed into one. This documents the gap.
    expect(isAllowedHealthCheckUrl('http://localhost:3000/health')).toBe(true);
    expect(isPublicHttpUrl('http://localhost:3000/health')).toBe(false);

    expect(isAllowedHealthCheckUrl('http://10.0.0.1/health')).toBe(true);
    expect(isPublicHttpUrl('http://10.0.0.1/health')).toBe(false);

    // Neither may reach cloud metadata.
    expect(isAllowedHealthCheckUrl('http://169.254.169.254/')).toBe(false);
    expect(isPublicHttpUrl('http://169.254.169.254/')).toBe(false);
  });
});
