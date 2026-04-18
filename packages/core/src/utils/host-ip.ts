/**
 * Host IP address resolution for env command templates.
 *
 * Exposes `{{host.ip_address}}` to env command Handlebars templates so
 * health-check URLs and container bind addresses can reach the daemon
 * host from inside a container network.
 */

import { networkInterfaces } from 'node:os';

/**
 * Detect the primary non-loopback IPv4 address on the host.
 *
 * Scans all network interfaces and returns the first non-internal IPv4
 * address found (skipping loopback, link-local, and container bridge
 * virtual addresses that are typically not user-routable).
 *
 * Returns undefined if no suitable address is found (e.g. host with only
 * loopback interfaces).
 */
export function detectPrimaryIpv4(): string | undefined {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    // Skip obvious virtual/container interfaces; users who need them can set
    // daemon.host_ip_address explicitly.
    if (/^(lo|docker|br-|veth|virbr|tailscale)/.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      // Skip link-local 169.254.x.x
      if (addr.address.startsWith('169.254.')) continue;
      candidates.push(addr.address);
    }
  }

  return candidates[0];
}

/**
 * Resolve the host IP address for template interpolation.
 *
 * Precedence: explicit config override > autodetected primary IPv4 >
 * undefined (template helper renders empty string).
 */
export function resolveHostIpAddress(configOverride: string | undefined): string | undefined {
  if (configOverride && configOverride.trim().length > 0) return configOverride.trim();
  return detectPrimaryIpv4();
}
