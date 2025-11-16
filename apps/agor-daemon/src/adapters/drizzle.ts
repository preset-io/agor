/**
 * Custom Drizzle Adapter for FeathersJS
 *
 * Lightweight adapter that bridges FeathersJS service interface with Drizzle ORM.
 * Uses the repository pattern from @agor/core/db for type-safe database operations.
 */

import type { Id, NullableId, Paginated, Params } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';

/**
 * Query operators supported by the adapter
 */
export interface Query {
  $limit?: number;
  $skip?: number;
  $sort?: Record<string, 1 | -1>;
  $select?: string[];
  // biome-ignore lint/suspicious/noExplicitAny: Query values can be any type
  [key: string]: any;
}

/**
 * Pagination configuration
 */
export interface PaginationOptions {
  default?: number;
  max?: number;
}

/**
 * Adapter options
 */
export interface DrizzleAdapterOptions {
  /**
   * Name of the ID field (default: 'id')
   */
  id?: string;

  /**
   * Pagination configuration
   */
  paginate?: PaginationOptions;

  /**
   * Allow multi-record operations (patch/remove without ID)
   */
  multi?: boolean | string[];

  /**
   * Resource type name for error messages (e.g., 'Worktree', 'Session')
   */
  resourceType?: string;
}

/**
 * Repository interface that the adapter expects
 */
export interface Repository<T> {
  create(data: Partial<T>): Promise<T>;
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  update(id: string, updates: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  count?(): Promise<number>;
}

/**
 * Drizzle Service Adapter
 *
 * Implements FeathersJS service methods using a Drizzle repository.
 * Emits events for real-time WebSocket broadcasting.
 */
// biome-ignore lint/suspicious/noExplicitAny: Generic service adapter needs default any type
export class DrizzleService<T = any, D = Partial<T>, P extends Params = Params> {
  id: string;
  paginate?: PaginationOptions;
  multi: boolean | string[];
  resourceType: string;

  // Event emitter for FeathersJS (will be injected by framework)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event system
  emit?: (event: string, ...args: any[]) => boolean;

  constructor(
    private repository: Repository<T>,
    options: DrizzleAdapterOptions = {}
  ) {
    this.id = options.id ?? 'id';
    this.paginate = options.paginate;
    this.multi = options.multi ?? false;
    this.resourceType = options.resourceType ?? 'Record';
  }

  /**
   * Extract query parameters from params
   */
  private getQuery(params?: P): Query {
    return (params?.query ?? {}) as Query;
  }

  /**
   * Apply filters to data array (client-side filtering)
   */
  private filterData(data: T[], query: Query): T[] {
    let filtered = [...data];

    // Filter by field values
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('$')) continue; // Skip operators

      // biome-ignore lint/suspicious/noExplicitAny: Generic filtering requires dynamic property access
      filtered = filtered.filter((item: any) => {
        // Simple equality check
        if (typeof value === 'object' && value !== null) {
          // Handle operators like $in, $ne, etc.
          for (const [op, opValue] of Object.entries(value)) {
            switch (op) {
              case '$in':
                return Array.isArray(opValue) && opValue.includes(item[key]);
              case '$nin':
                return Array.isArray(opValue) && !opValue.includes(item[key]);
              case '$ne':
                return item[key] !== opValue;
              case '$gt':
                // biome-ignore lint/suspicious/noExplicitAny: Query operator values are dynamic
                return item[key] > (opValue as any);
              case '$gte':
                // biome-ignore lint/suspicious/noExplicitAny: Query operator values are dynamic
                return item[key] >= (opValue as any);
              case '$lt':
                // biome-ignore lint/suspicious/noExplicitAny: Query operator values are dynamic
                return item[key] < (opValue as any);
              case '$lte':
                // biome-ignore lint/suspicious/noExplicitAny: Query operator values are dynamic
                return item[key] <= (opValue as any);
            }
          }
        }
        return item[key] === value;
      });
    }

    return filtered;
  }

  /**
   * Sort data array
   */
  private sortData(data: T[], sortSpec?: Record<string, 1 | -1>): T[] {
    if (!sortSpec) return data;

    const sorted = [...data];
    const entries = Object.entries(sortSpec);

    // biome-ignore lint/suspicious/noExplicitAny: Generic sorting requires dynamic property access
    sorted.sort((a: any, b: any) => {
      for (const [field, direction] of entries) {
        const aVal = a[field];
        const bVal = b[field];

        if (aVal < bVal) return direction === 1 ? -1 : 1;
        if (aVal > bVal) return direction === 1 ? 1 : -1;
      }
      return 0;
    });

    return sorted;
  }

  /**
   * Select specific fields from data
   */
  private selectFields(data: T[], fields?: string[]): Partial<T>[] {
    if (!fields || fields.length === 0) return data;

    // biome-ignore lint/suspicious/noExplicitAny: Field selection requires dynamic property access
    return data.map((item: any) => {
      // biome-ignore lint/suspicious/noExplicitAny: Result object has dynamic fields
      const selected: any = {};
      for (const field of fields) {
        if (field in item) {
          selected[field] = item[field];
        }
      }
      return selected;
    });
  }

  /**
   * Apply pagination to data
   */
  private paginateData(data: T[], query: Query, total: number): Paginated<T> | T[] {
    const limit = query.$limit ?? this.paginate?.default ?? data.length;
    const skip = query.$skip ?? 0;

    // If pagination is disabled, return all data
    if (!this.paginate) {
      return data;
    }

    // Apply limit (capped by max)
    const maxLimit = this.paginate.max ?? 1000;
    const actualLimit = Math.min(limit, maxLimit);

    // Slice data
    const paginated = data.slice(skip, skip + actualLimit);

    return {
      total,
      limit: actualLimit,
      skip,
      data: paginated,
    };
  }

  /**
   * Find records
   */
  async find(params?: P): Promise<Paginated<T> | T[]> {
    const query = this.getQuery(params);

    // Get all data from repository
    let data = await this.repository.findAll();

    // Get total count before filtering
    const total = data.length;

    // Apply filters
    data = this.filterData(data, query);

    // Apply sorting
    data = this.sortData(data, query.$sort);

    // Apply field selection
    const selected = this.selectFields(data, query.$select);

    // Apply pagination
    return this.paginateData(selected as T[], query, total);
  }

  /**
   * Get a single record by ID
   */
  async get(id: Id, _params?: P): Promise<T> {
    const result = await this.repository.findById(String(id));

    if (!result) {
      throw new NotFoundError(this.resourceType, String(id));
    }

    return result;
  }

  /**
   * Create one or more records
   */
  async create(data: D | D[], params?: P): Promise<T | T[]> {
    if (Array.isArray(data)) {
      // Bulk create
      const results = await Promise.all(
        data.map((item) => this.repository.create(item as Partial<T>))
      );
      // Emit created event for each item
      for (const result of results) {
        this.emit?.('created', result, params);
      }
      return results;
    }

    const result = await this.repository.create(data as Partial<T>);
    this.emit?.('created', result, params);
    return result;
  }

  /**
   * Update a record (complete replacement)
   */
  async update(id: Id, data: D, params?: P): Promise<T> {
    // Verify record exists (throws NotFoundError if not found)
    await this.get(id, params);

    const result = await this.repository.update(String(id), data as Partial<T>);
    this.emit?.('updated', result, params);
    this.emit?.('patched', result, params); // Also emit patched for consistency
    return result;
  }

  /**
   * Patch a record (partial update)
   */
  async patch(id: NullableId, data: D, params?: P): Promise<T | T[]> {
    if (id === null) {
      // Multi-patch not supported in simple implementation
      if (!this.multi) {
        throw new Error('Multi-patch is not enabled');
      }

      // Find all matching records and patch them
      const query = this.getQuery(params);
      let records = await this.repository.findAll();
      records = this.filterData(records, query);

      const results = await Promise.all(
        records.map((record) =>
          this.repository.update(
            (record as Record<string, unknown>)[this.id] as string,
            data as Partial<T>
          )
        )
      );

      // Emit events for each patched record
      for (const result of results) {
        this.emit?.('patched', result, params);
      }

      return results;
    }

    // Single patch
    // Verify record exists (throws NotFoundError if not found)
    await this.get(id, params);

    const result = await this.repository.update(String(id), data as Partial<T>);
    this.emit?.('patched', result, params);
    return result;
  }

  /**
   * Remove one or more records
   */
  async remove(id: NullableId, params?: P): Promise<T | T[]> {
    if (id === null) {
      // Multi-remove not supported in simple implementation
      if (!this.multi) {
        throw new Error('Multi-remove is not enabled');
      }

      // Find all matching records and remove them
      const query = this.getQuery(params);
      let records = await this.repository.findAll();
      records = this.filterData(records, query);

      // biome-ignore lint/suspicious/noExplicitAny: Need to access ID field dynamically
      await Promise.all(records.map((record) => this.repository.delete((record as any)[this.id])));

      // Emit removed event for each record
      for (const record of records) {
        this.emit?.('removed', record, params);
      }

      return records;
    }

    // Single remove
    // Get record before deletion (throws NotFoundError if not found)
    const existing = await this.get(id, params);

    await this.repository.delete(String(id));
    this.emit?.('removed', existing, params);
    return existing;
  }
}
