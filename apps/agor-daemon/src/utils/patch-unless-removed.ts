import { shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params } from '@agor/core/types';
import { isNotFoundError } from '@agor/core/utils/errors';

/**
 * Patch an entity unless a concurrent delete already removed it.
 *
 * This is intended for deferred/background completion paths where deletion is
 * a valid race outcome. Other patch failures remain authoritative and bubble
 * to the caller.
 */
export async function patchUnlessRemoved<T>(
  app: Application,
  serviceName: string,
  id: string,
  data: Partial<T>,
  entityType: string,
  params?: Params
): Promise<boolean> {
  try {
    await app.service(serviceName).patch(id, data, params ?? {});
    return true;
  } catch (error) {
    if (
      isNotFoundError(error) ||
      (error instanceof Error && error.message.includes('No record found'))
    ) {
      console.log(`⚠️  ${entityType} ${shortId(id)} was deleted mid-execution - skipping update`);
      return false;
    }
    throw error;
  }
}
