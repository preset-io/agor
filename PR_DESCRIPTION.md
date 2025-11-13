# Add OAuth support for Gemini via shared CLI credentials

## What

Enables Agor to use OAuth authentication for Gemini sessions when no API key is configured. The `@google/gemini-cli-core` SDK already had OAuth support built-in - we just needed to use it! When no `GEMINI_API_KEY` is set, Agor now automatically falls back to OAuth authentication using credentials from `~/.gemini/oauth_creds.json`.

## Why

- **Better developer experience**: Users who have already authenticated with `gemini` CLI don't need to manage separate API keys
- **Seamless integration**: Automatically shares OAuth credentials with the Gemini CLI tool
- **Cost savings**: OAuth access through Gemini Code Assist may have different rate limits/costs than direct API key usage
- **Flexibility**: Users can choose between API key (explicit) or OAuth (automatic) authentication
- **Zero dependencies**: Uses existing SDK capabilities, no new packages needed

## How

**Minimal changes to existing code:**

1. **`packages/core/src/tools/gemini/prompt-service.ts`**:
   - Added logic to detect when no API key is available
   - Falls back to `AuthType.LOGIN_WITH_GOOGLE` (OAuth) instead of `AuthType.USE_GEMINI` (API key)
   - The `@google/gemini-cli-core` SDK already supported this auth type - it reads from `~/.gemini/oauth_creds.json` automatically
   - Updated both initial auth and refresh auth to support both modes dynamically

2. **`apps/agor-daemon/src/index.ts`**:
   - Updated warning message to mention OAuth fallback instead of saying sessions will fail
   - Added helpful instructions for users about OAuth requirements

**Key insight:** The existing `@google/gemini-cli-core` dependency already had `AuthType.LOGIN_WITH_GOOGLE` support built-in. We just needed to use it when no API key was present. No additional dependencies required!

## Testing

**Manual testing checklist:**

- [ ] Test OAuth authentication works when no API key is set
  1. Remove/unset `GEMINI_API_KEY` from config and environment
  2. Ensure `gemini` CLI is installed and authenticated (run `gemini` command to verify)
  3. Create a Gemini session in Agor
  4. Verify it authenticates successfully using OAuth
  5. Check daemon logs for "🔐 [Gemini] No API key found, using OAuth authentication (Gemini CLI)"
  6. Verify the session can send messages and receive responses

- [ ] Test API key authentication still works
  1. Set `GEMINI_API_KEY` in config: `agor config set credentials.GEMINI_API_KEY <key>`
  2. Create a Gemini session
  3. Verify it uses API key authentication
  4. Check daemon logs for "🔑 [Gemini] Using per-user/global API key"

- [ ] Test hot-reload of credentials
  1. Start with OAuth (no API key)
  2. Create a session and verify OAuth is used
  3. Add API key via `agor config set credentials.GEMINI_API_KEY <key>`
  4. Create a new session
  5. Verify it switches to API key auth

**Automated testing:**

- ✅ TypeScript type checking passed
- ✅ Lint checks passed
- ✅ Pre-commit hooks passed
- ✅ Build successful

## Code Changes Summary

```
apps/agor-daemon/src/index.ts                    |   6 +-
packages/core/src/tools/gemini/prompt-service.ts |  32 +++-
```

**Total: ~40 lines changed across 2 files**

## Backward Compatibility

✅ **Fully backward compatible**

- Existing API key authentication works exactly as before
- OAuth is only used when no API key is configured
- No breaking changes to API or behavior
- No new dependencies added

## Related

The idea came from investigating https://github.com/ben-vargas/ai-sdk-provider-gemini-cli which shows OAuth integration patterns. However, we discovered the underlying SDK already had this capability, so no wrapper was needed.
