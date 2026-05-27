/**
 * buildPrompterPrefixedPrompt
 *
 * When a user who is NOT the session creator prompts a session, we tag
 * the bytes shipped to the executor (and only those bytes — the
 * transcript row keeps the original prompt) with a small attribution
 * header so the agent knows who is talking to it in multi-user sessions:
 *
 *     [Prompted by: Alice (alice@example.com)]
 *
 *     <original prompt>
 *
 * Originally landed in #781 ("feat: pass user context to agents for
 * multi-user sessions"). The logic later moved inline into
 * `spawnTaskExecutor` during the never-lose-a-prompt refactor (#1068)
 * and ended up coupled to `params.user.user_id`, which silently drops
 * the prefix on any drain/callback path that doesn't carry a populated
 * `queued_by_user_id` through the queue → spawn hop. This module
 * decouples the logic from request params: callers pass the prompter
 * user id explicitly (typically `task.created_by`, which is stamped at
 * prompt time and survives the queue intact).
 *
 * No-ops (returns the raw prompt unchanged, `prefixed: false`):
 *   - prompter id missing (best-effort — never throws on internal calls)
 *   - prompter id matches the session creator
 *   - user lookup returns null (deleted user)
 *   - user lookup throws (logged via `console.warn`, swallowed)
 */

import { shortId } from '@agor/core/db';
import type { User } from '@agor/core/types';

const FIELD_MAX_LEN = 100;

/**
 * Strip newlines/control chars and cap length before embedding a
 * user-controlled field (name, email) into the prompt — defense against
 * prompt injection via a crafted profile.
 */
export function sanitizeUserField(value: string, maxLength = FIELD_MAX_LEN): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .substring(0, maxLength);
}

/** Format the attribution header for a prompter. Exported for tests / reuse. */
export function formatPrompterPrefix(prompter: Pick<User, 'name' | 'email'>): string {
  const name = sanitizeUserField(prompter.name || prompter.email);
  const email = sanitizeUserField(prompter.email);
  return `[Prompted by: ${name} (${email})]`;
}

/**
 * Minimal user-repository shape this helper depends on. Kept narrow so
 * tests can pass a hand-rolled stub without dragging in Drizzle.
 */
export interface PrompterLookup {
  findById(id: string): Promise<Pick<User, 'name' | 'email'> | null>;
}

export interface BuildPrompterPrefixedPromptInput {
  rawPrompt: string;
  /** Session creator's user id. The prefix is skipped when prompter === creator. */
  sessionCreatedBy: string | undefined;
  /**
   * Prompter's user id. Pass `task.created_by` — it's stamped at prompt
   * submission and is the authoritative "who is talking to the agent
   * right now" signal that survives the queue hop.
   */
  prompterUserId: string | undefined;
  usersRepo: PrompterLookup;
}

export interface BuildPrompterPrefixedPromptResult {
  prompt: string;
  /** True iff an attribution header was applied. */
  prefixed: boolean;
}

export async function buildPrompterPrefixedPrompt(
  input: BuildPrompterPrefixedPromptInput
): Promise<BuildPrompterPrefixedPromptResult> {
  const { rawPrompt, sessionCreatedBy, prompterUserId, usersRepo } = input;

  if (!prompterUserId || prompterUserId === sessionCreatedBy) {
    return { prompt: rawPrompt, prefixed: false };
  }

  let prompter: Pick<User, 'name' | 'email'> | null;
  try {
    prompter = await usersRepo.findById(prompterUserId);
  } catch (err) {
    console.warn(`[Prompt] Failed to look up prompter user ${shortId(prompterUserId)}:`, err);
    return { prompt: rawPrompt, prefixed: false };
  }

  if (!prompter) {
    return { prompt: rawPrompt, prefixed: false };
  }

  return {
    prompt: `${formatPrompterPrefix(prompter)}\n\n${rawPrompt}`,
    prefixed: true,
  };
}
