/**
 * `isPublicHttpUrl` is the outbound-request filter for URLs that arrive from
 * outside Agor — today the MCP catalog's auth probe, which follows endpoints
 * anyone can publish to a public registry. Every case below is a spelling of an
 * address that reaches the daemon's own network.
 */

import { describe, expect, it } from 'vitest';
import { isAllowedHealthCheckUrl, isPrivateIpAddress, isPublicHttpUrl } from './url';

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

/**
 * The literal-URL path and the resolved-address path are different call sites
 * sharing one classifier, so every range is asserted through both.
 */
describe('globally reachable address space', () => {
  const notGloballyReachable: Array<[string, string]> = [
    ['0.0.0.0', 'this network'],
    ['10.0.0.5', 'RFC 1918'],
    ['100.64.0.1', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local cloud metadata'],
    ['172.20.1.1', 'RFC 1918'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', 'deprecated 6to4 relay anycast'],
    ['192.168.1.10', 'RFC 1918'],
    ['198.18.0.1', 'RFC 2544 benchmarking'],
    ['198.19.255.254', 'RFC 2544 benchmarking, upper half'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['64:ff9b::1', 'NAT64 well-known prefix'],
    ['100::1', 'discard-only'],
    ['2001::1', 'Teredo'],
    ['2001:2::1', 'benchmarking'],
    ['2001:db8::1', 'documentation'],
    ['2002::1', 'deprecated 6to4'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fec0::1', 'deprecated site-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ];

  it.each(notGloballyReachable)('refuses %s (%s) as a resolved address', (address) => {
    expect(isPrivateIpAddress(address)).toBe(true);
  });

  it.each(notGloballyReachable)('refuses %s (%s) as a literal URL host', (address) => {
    const host = address.includes(':') ? `[${address}]` : address;
    expect(isPublicHttpUrl(`http://${host}/`)).toBe(false);
  });

  const globallyReachable: Array<[string, string]> = [
    ['1.1.1.1', 'public resolver'],
    ['8.8.8.8', 'public resolver'],
    ['93.184.216.34', 'public host'],
    ['223.255.255.254', 'top of IPv4 unicast'],
    ['2001:4860:4860::8888', 'public IPv6 resolver'],
    ['2606:2800:220::1', 'public IPv6 host'],
    ['2a00:1450:4001:80f::200e', 'public IPv6 host'],
  ];

  it.each(globallyReachable)('allows %s (%s) through both paths', (address) => {
    const host = address.includes(':') ? `[${address}]` : address;
    expect(isPrivateIpAddress(address)).toBe(false);
    expect(isPublicHttpUrl(`http://${host}/`)).toBe(true);
  });

  it('refuses an address it cannot parse rather than assuming it is public', () => {
    // Default-deny is the whole point of classifying against reachable space:
    // an unparseable answer is not evidence of a safe destination.
    expect(isPrivateIpAddress('not-an-address')).toBe(true);
    expect(isPrivateIpAddress('')).toBe(true);
    expect(isPrivateIpAddress('2001:db8::gggg')).toBe(true);
  });
});
