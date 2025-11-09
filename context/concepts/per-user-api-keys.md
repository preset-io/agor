# Per-User API Keys

**Status:** ✅ Implemented (Oct 2025)
**Related:** [[auth]], [[agent-integration]], [[user-env-vars]]

---

## Overview

Users can store Anthropic, OpenAI, and Gemini API keys inside Agor. Keys are encrypted, scoped per user, and exposed only as boolean flags in the UI so you can confirm presence without seeing secrets.

## Implementation Details

- Encryption helpers: `packages/core/src/db/encryption.ts`
- Types: `packages/core/src/types/user.ts` includes `api_keys` + boolean status map
- Service: `apps/agor-daemon/src/services/users.ts` handles encrypt/decrypt + status responses
- UI: `apps/agor-ui/src/components/ApiKeyFields.tsx` renders masked inputs with Save/Clear flows (reused in user modal + agentic tools tab)

Keys automatically flow to all agent SDKs when spawning subprocesses, so switching tools requires zero reconfiguration.

## Usage

1. Open Settings → Agentic Tools.
2. Enter API keys; click **Save** to encrypt + persist.
3. UI shows a green check when a key exists; **Clear** removes it.
4. Agents fall back to workspace-level env vars if keys are absent.

_Past exploration lives in `context/archives/per-user-api-keys.md`._
