import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import type { Candidate, Resident, WorkerInventory } from './placement.js';

/** Stored outside SDK mounts. SQL timestamps, not worker clocks, expire advertisements. */
export class WorkspaceInventory {
  private readonly observedTenants = new Set<string>();
  readonly entries = new Map<string, Resident>();
  constructor(
    private root: string,
    private sql: postgres.Sql,
    readonly origin: string
  ) {}
  private key(tenant: string, branch: string) {
    return `${tenant}/${branch}`;
  }
  async load() {
    try {
      const entries = JSON.parse(
        await readFile(path.join(this.root, 'residency.json'), 'utf8')
      ) as [string, Resident][];
      for (const [key, value] of entries) this.entries.set(key, value);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  private saving: Promise<void> = Promise.resolve();
  save(): Promise<void> {
    const content = JSON.stringify([...this.entries]);
    const save = this.saving.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = path.join(this.root, `residency-${randomUUID()}.json`);
      await writeFile(file, content, { mode: 0o600 });
      await rename(file, path.join(this.root, 'residency.json'));
    });
    this.saving = save.catch(() => undefined);
    return save;
  }
  touch(tenant: string, branch: string, repository: string, session?: string) {
    const key = this.key(tenant, branch);
    const entry = this.entries.get(key) ?? {
      branchId: branch,
      repository,
      sessions: [],
      revision: null,
      lastUsed: 0,
      resident: false,
      generation: randomUUID(),
      preparationMs: 0,
    };
    entry.lastUsed = Date.now();
    entry.repository = repository;
    if (session && !entry.sessions.includes(session)) entry.sessions.push(session);
    this.entries.set(key, entry);
    return entry;
  }
  tenantEntries(tenant: string) {
    return [...this.entries].filter(([key]) => key.startsWith(`${tenant}/`)).map(([, r]) => r);
  }
  tenants() {
    return [
      ...new Set([
        ...this.observedTenants,
        ...[...this.entries.keys()].map((key) => key.split('/')[0]),
      ]),
    ];
  }
  async advertise(tenant: string, inventory: WorkerInventory) {
    this.observedTenants.add(tenant);
    await this.sql.begin(async (tx) => {
      await tx`select set_config('agor.workspace_tenant', ${tenant}, true)`;
      await tx`insert into agor_workspace_inventory(tenant_id,worker_id,inventory,seen_at)
        values(${tenant},${this.origin},${tx.json(inventory as unknown as postgres.JSONValue)},clock_timestamp())
        on conflict(tenant_id,worker_id) do update set inventory=excluded.inventory,seen_at=excluded.seen_at`;
    });
  }
  async candidates(tenant: string): Promise<Candidate[]> {
    return (await this.sql.begin(async (tx) => {
      await tx`select set_config('agor.workspace_tenant', ${tenant}, true)`;
      const rows =
        await tx`select inventory, extract(epoch from (clock_timestamp()-seen_at))*1000 as age
        from agor_workspace_inventory where tenant_id=${tenant} and seen_at > clock_timestamp()-interval '5 minutes'`;
      return rows.map((row) => ({ ...(row.inventory as WorkerInventory), ageMs: Number(row.age) }));
    })) as unknown as Candidate[];
  }
}
