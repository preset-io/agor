/**
 * EXPLORATORY POC: params-aware repository seam for DrizzleService.
 *
 * Agor's current DrizzleService stores one repository created with one db. This
 * sketch shows the preferred mechanical change: services resolve a repository
 * from `params.tenant` per method call instead of mutating any global db handle.
 */

import type { Id, NullableId, Params } from '@agor/core/types';
import type { Repository } from '../adapters/drizzle.js';
import type { TenantRepositoryProvider } from './tenant-db-registry.js';

export class TenantRoutedRepositoryAdapter<T, D = Partial<T>, P extends Params = Params> {
  constructor(
    private readonly repositories: TenantRepositoryProvider<Repository<T>>,
    private readonly idField: keyof T & string
  ) {}

  private repo(params?: P): Promise<Repository<T>> {
    return this.repositories.forParams(params);
  }

  async find(params?: P): Promise<T[]> {
    return (await this.repo(params)).findAll();
  }

  async get(id: Id, params?: P): Promise<T> {
    const result = await (await this.repo(params)).findById(String(id));
    if (!result) throw new Error(`Record not found: ${String(id)}`);
    return result;
  }

  async create(data: D, params?: P): Promise<T> {
    return (await this.repo(params)).create(data as Partial<T>);
  }

  async patch(id: NullableId, data: D, params?: P): Promise<T> {
    if (id === null) throw new Error('Multi-patch omitted from tenant routing POC');
    return (await this.repo(params)).update(String(id), data as Partial<T>);
  }

  async remove(id: NullableId, params?: P): Promise<T> {
    if (id === null) throw new Error('Multi-remove omitted from tenant routing POC');
    const repo = await this.repo(params);
    const existing = await repo.findById(String(id));
    if (!existing) throw new Error(`Record not found: ${String(id)}`);
    await repo.delete(String((existing as Record<string, unknown>)[this.idField]));
    return existing;
  }
}
