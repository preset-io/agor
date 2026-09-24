import { OpenCodeNativeStateHandoffRequiredError } from '@agor/core/db';
import { Conflict } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

/** Preserve the permanent, typed native-state refusal at REST and socket edges. */
export function mapNativeStateHandoffError(context: HookContext): HookContext {
  if (context.error instanceof OpenCodeNativeStateHandoffRequiredError) {
    context.error = new Conflict(context.error.message, {
      code: 'native_state_handoff_required',
      retryable: false,
    });
  }
  return context;
}
