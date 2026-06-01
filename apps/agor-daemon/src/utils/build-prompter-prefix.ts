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
 * Match any Unicode control character (`\p{Cc}` = the C0 + C1 control
 * blocks, including \r \n \t \0 \x1b \v \f and friends) plus the two
 * separator code points that render as line breaks but live outside
 * \p{Cc} (U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR). The `+`
 * collapses runs of these to a single space so a crafted profile can't
 * pad the output with extra whitespace.
 */
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\u2028\u2029]+/gu;

/**
 * Strip control chars / line-separator code points and cap length
 * before embedding a user-controlled field (name, email) into the
 * prompt — defense against prompt injection via a crafted profile.
 *
 * Length is enforced in *code points* (via `Array.from`) rather than
 * UTF-16 code units, so truncation never splits a surrogate pair (an
 * emoji-padded name can no longer leave a half-character at the cap).
 */
export function sanitizeUserField(value: string | undefined, maxLength = FIELD_MAX_LEN): string {
  const cleaned = (value ?? '').replace(CONTROL_OR_LINE_SEPARATOR, ' ').trim();
  return Array.from(cleaned).slice(0, maxLength).join('');
}

/**
 * Format the attribution header for a prompter. Exported for tests / reuse.
 *
 * Sanitizes name and email separately, then falls back name → email →
 * `'unknown user'`. A whitespace-only name no longer leaks through as a
 * blank display (the old `name || email` ran before sanitization, so
 * `'   '` was truthy).
 */
export function formatPrompterPrefix(prompter: Pick<User, 'name' | 'email'>): string {
  const email = sanitizeUserField(prompter.email);
  const name = sanitizeUserField(prompter.name) || email || 'unknown user';
  return email ? `[Prompted by: ${name} (${email})]` : `[Prompted by: ${name}]`;
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
