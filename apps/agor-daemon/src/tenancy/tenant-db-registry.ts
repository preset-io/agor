/** EXPLORATORY POC: tenant database registry/provider. Not production-wired. */

import type { Database } from '@agor/core/db';
import type { Params } from '@agor/core/types';
import { requireTenant, type TenantID } from './tenant-context.js';

export type TenantDatabaseFactory = (tenantId: TenantID) => Promise<Database> | Database;

export interface TenantDatabaseRegistryOptions {
  createDatabase: TenantDatabaseFactory;
  closeDatabase?: (db: Database, tenantId: TenantID) => Promise<void> | void;
}

export class TenantDatabaseRegistry {
  private readonly databases = new Map<TenantID, Promise<Database>>();

  constructor(private readonly options: TenantDatabaseRegistryOptions) {}

  get(tenantId: TenantID): Promise<Database> {
    let existing = this.databases.get(tenantId);
    if (!existing) {
      existing = Promise.resolve(this.options.createDatabase(tenantId));
      this.databases.set(tenantId, existing);
    }
    return existing;
  }

  async getForParams(params: Params | undefined): Promise<Database> {
    return this.get(requireTenant(params).tenantId);
  }

  async closeAll(): Promise<void> {
    if (!this.options.closeDatabase) {
      this.databases.clear();
      return;
    }
    const entries = [...this.databases.entries()];
    this.databases.clear();
    await Promise.all(entries.map(async ([tenantId, db]) => this.options.closeDatabase!(await db, tenantId)));
  }
}

export type RepositoryFactory<R> = (db: Database) => R;

export class TenantRepositoryProvider<R> {
  private readonly repositories = new Map<TenantID, Promise<R>>();

  constructor(
    private readonly registry: TenantDatabaseRegistry,
    private readonly factory: RepositoryFactory<R>
  ) {}

  forParams(params: Params | undefined): Promise<R> {
    const { tenantId } = requireTenant(params);
    let existing = this.repositories.get(tenantId);
    if (!existing) {
      existing = this.registry.get(tenantId).then((db) => this.factory(db));
      this.repositories.set(tenantId, existing);
    }
    return existing;
  }
}
