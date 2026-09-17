import { readFileSync } from 'node:fs';
import { ManagedAuthorityClockError } from './managed-clock.js';

/** Linux /proc/uptime truncates suspend-inclusive CLOCK_BOOTTIME to hundredths. */
export const MANAGED_BOOT_TIME_QUANTIZATION_MS = 10;

/** Fixed kernel source, never a tenant path, file mtime or wall-clock health assertion. */
export function readManagedBootTimeMs(): number {
  try {
    const value = readFileSync('/proc/uptime', 'utf8');
    if (value.length > 128) throw new ManagedAuthorityClockError();
    const match = /^(\d+)\.(\d{2}) \d+\.\d{2}\n?$/.exec(value);
    if (!match) throw new ManagedAuthorityClockError();
    const ms = Number(match[1]) * 1000 + Number(match[2]) * MANAGED_BOOT_TIME_QUANTIZATION_MS;
    if (!Number.isSafeInteger(ms) || ms < 0) throw new ManagedAuthorityClockError();
    return ms;
  } catch {
    throw new ManagedAuthorityClockError();
  }
}
