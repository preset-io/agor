import type { UserRole } from '@agor-live/client';
import { ROLES } from '@agor-live/client';

/**
 * Minimum role required to open a web terminal when the instance-level
 * `execution.allow_web_terminal` flag is enabled. Shared with the app shell
 * (`components/App/App.tsx`) so the gate only exists in one place.
 *
 * Lives in its own tiny module (separate from `TerminalModal.tsx`) so the app
 * shell can import the role gate without pulling the xterm-heavy modal into
 * the initial bundle.
 */
export const WEB_TERMINAL_MIN_ROLE: UserRole = ROLES.MEMBER;
