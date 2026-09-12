import type {
  WorkspaceMetadata,
  WorkspaceScope,
  WorkspaceState,
} from '@agor/core/workspaces/types';
import type postgres from 'postgres';

/** Worker authority uses server time and row locks; SDK containers never receive this connection. */
export class WorkerSqlAuthority implements WorkspaceMetadata {
  constructor(
    private readonly sql: postgres.Sql,
    readonly scope: WorkspaceScope,
    readonly slot = 'code'
  ) {}
  private async unit<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('agor.workspace_tenant', ${this.scope.tenantId}, true)`;
      return work(tx);
    }) as Promise<T>;
  }
  async read(): Promise<{ state: WorkspaceState | null; now: number }> {
    return this.unit(async (tx) => {
      const rows =
        await tx`select state from agor_workspace_authority where tenant_id=${this.scope.tenantId} and branch_id=${this.scope.branchId} and slot=${this.slot}`;
      const [clock] =
        await tx`select floor(extract(epoch from clock_timestamp())*1000)::bigint as now`;
      return { state: (rows[0]?.state ?? null) as WorkspaceState | null, now: Number(clock.now) };
    });
  }
  async mutate<T>(
    work: (state: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
  ): Promise<T> {
    return this.unit(async (tx) => {
      await tx`insert into agor_workspace_authority(tenant_id,branch_id,slot,state) values(${this.scope.tenantId},${this.scope.branchId},${this.slot},null) on conflict do nothing`;
      const [row] =
        await tx`select state from agor_workspace_authority where tenant_id=${this.scope.tenantId} and branch_id=${this.scope.branchId} and slot=${this.slot} for update`;
      const [clock] =
        await tx`select floor(extract(epoch from clock_timestamp())*1000)::bigint as now`;
      const next = work(row.state as WorkspaceState | null, Number(clock.now));
      if (
        next.state.scope.tenantId !== this.scope.tenantId ||
        next.state.scope.branchId !== this.scope.branchId
      )
        throw new Error('Workspace authority scope mismatch');
      await tx`update agor_workspace_authority set state=${tx.json(next.state as unknown as postgres.JSONValue)} where tenant_id=${this.scope.tenantId} and branch_id=${this.scope.branchId} and slot=${this.slot}`;
      return next.result;
    });
  }
}
