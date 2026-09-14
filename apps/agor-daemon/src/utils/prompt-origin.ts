import { getGatewaySource, type PromptOrigin, type Session, type Task } from '@agor/core/types';

/**
 * Derive provider prompt trust from daemon-owned durable state.
 *
 * An omitted result is intentional: callbacks, system-authored prompts, and
 * unattributed internal producers must not acquire human authority merely
 * because they ultimately enter an SDK as a user-role message.
 */
export function resolvePromptOrigin(
  task: Pick<Task, 'metadata'>,
  session: Pick<Session, 'custom_context'>
): PromptOrigin | undefined {
  if (task.metadata?.is_agor_callback || task.metadata?.system_authored) return undefined;

  if (task.metadata?.source === 'gateway') {
    const gatewaySource = getGatewaySource(session);
    return gatewaySource ? { kind: 'channel', server: gatewaySource.channel_type } : undefined;
  }

  return task.metadata?.source === 'agor' ? { kind: 'human' } : undefined;
}
