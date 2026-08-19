import {
  type CreateDistributedWorkIdentityOptions,
  createDistributedWorkIdentity,
  type DistributedWorkIdentity,
} from '@agor/core/coordination';
import type { Application } from '../declarations.js';

export type InitializeDistributedWorkIdentityOptions = CreateDistributedWorkIdentityOptions;

/**
 * Own the process-wide distributed-work diagnostic identity on the Feathers
 * application. Repeated initialization is idempotent so no second boot ID can
 * be generated accidentally within one application/process incarnation.
 */
export function initializeDistributedWorkIdentity(
  app: Pick<Application, 'get' | 'set'>,
  options: InitializeDistributedWorkIdentityOptions
): DistributedWorkIdentity {
  const existing = app.get('distributedWorkIdentity');
  if (existing) return existing;

  const identity = createDistributedWorkIdentity(options);
  app.set('distributedWorkIdentity', identity);
  return identity;
}
