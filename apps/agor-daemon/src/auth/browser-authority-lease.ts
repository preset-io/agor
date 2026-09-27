/** Monotonic connection lease. A late/failed read can never extend expired authority. */
export const BROWSER_AUTHORITY_LEASE_MS = 60_000;
export const BROWSER_AUTHORITY_RENEW_MS = 30_000;

export class BrowserAuthorityLease {
  private deadline: number;
  private retired = false;
  private pending = false;
  constructor(
    started: number,
    private readonly now = () => performance.now()
  ) {
    this.deadline = started + BROWSER_AUTHORITY_LEASE_MS;
  }
  current(): boolean {
    if (this.now() >= this.deadline) this.retired = true;
    return !this.retired;
  }
  retire(): void {
    this.retired = true;
  }
  async renew(check: () => Promise<void>): Promise<boolean> {
    if (!this.current() || this.pending) return this.current();
    const started = this.now();
    this.pending = true;
    try {
      await check();
      if (!this.current() || this.now() >= started + BROWSER_AUTHORITY_LEASE_MS) return false;
      this.deadline = started + BROWSER_AUTHORITY_LEASE_MS;
      return true;
    } catch {
      this.retire();
      return false;
    } finally {
      this.pending = false;
    }
  }
}

const leases = new WeakMap<object, BrowserAuthorityLease>();
export function bindBrowserAuthorityLease(connection: object, lease: BrowserAuthorityLease): void {
  leases.set(connection, lease);
}
export function browserAuthorityLeaseCurrent(connection: object): boolean {
  return leases.get(connection)?.current() ?? true;
}
export function retireBrowserAuthorityLease(connection: object): void {
  leases.get(connection)?.retire();
}
