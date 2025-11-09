# User Environment Variables

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[per-user-api-keys]], [[agent-integration]], [[worktrees]]

---

## Overview

Users can define arbitrary environment variables (e.g., `GITHUB_TOKEN`, `NPM_TOKEN`) that propagate to:

- Agent subprocesses (Claude/Codex/Gemini/OpenCode)
- Terminal sessions
- Worktree environment commands

Values are encrypted per user and merged into `process.env` just before spawning child processes, honoring a safety blocklist.

## Implementation Highlights

- Schema: `users.data.env_vars` JSON blob (`packages/core/src/db/schema.ts`)
- Encryption + merge logic: `apps/agor-daemon/src/services/users.ts` and `packages/core/src/config/env-resolver.ts`
- UI editor: `apps/agor-ui/src/components/EnvVarEditor.tsx` (used inside Settings → Users)
- Terminal + SDK integration: `apps/agor-daemon/src/services/terminals.ts`, `packages/core/src/tools/{claude,codex,gemini}/`

## Usage

1. Settings → Users → select yourself → Environment Variables section.
2. Add uppercase key + value; save to encrypt.
3. Entries show as "Set"/"Not set" badges; delete if no longer needed.
4. Agents automatically pick up values on the next tool call; no restart required.

_Background decisions archived at `context/archives/user-env-vars.md`._
