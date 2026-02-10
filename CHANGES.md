# Session URLs in Slack Gateway Messages

## Summary

Added support for including clickable session URLs in Slack Gateway messages. When a new session is created via Slack integration, users now see a direct link to the session in Agor.

## Changes Made

### 1. Configuration (`packages/core/src/config/types.ts`)

Added `base_url` configuration option to `AgorDaemonSettings`:

```yaml
daemon:
  base_url: https://agor.sandbox.preset.zone
```

This allows configuring the external/public URL for the Agor instance, which is used to generate user-facing links.

**Resolution order:**
1. `AGOR_BASE_URL` environment variable (highest priority)
2. `daemon.base_url` from `config.yaml`
3. Default: `http://localhost:{port}` (constructed from daemon port)

### 2. Config Manager (`packages/core/src/config/config-manager.ts`)

Added `getBaseUrl()` function:

```typescript
export async function getBaseUrl(): Promise<string>
```

This function:
- Resolves the base URL according to the priority order above
- Automatically strips trailing slashes for consistent URL formatting
- Returns a URL suitable for constructing external links (e.g., `https://agor.sandbox.preset.zone`)

### 3. Gateway Service (`apps/agor-daemon/src/services/gateway.ts`)

Updated the session creation logic to:

1. Import `getBaseUrl` from `@agor/core/config`
2. Fetch the worktree to determine which board it's on
3. Generate a clickable session URL in the format: `{baseUrl}/b/{boardId}/{sessionId}/`
4. Send this URL in the Slack debug message

**Before:**
```
[system] Session a5e907ac created, sending prompt to agent...
```

**After:**
```
[system] Session created: https://agor.sandbox.preset.zone/b/01234567/a5e907ac/
```

If the worktree is not on a board or URL generation fails, it falls back to the original message format.

### 4. Configuration (`~/.agor/config.yaml`)

Updated the configuration file to include:

```yaml
daemon:
  base_url: https://agor.sandbox.preset.zone
```

## Usage

### For Development

By default, the base URL will be `http://localhost:3030` (or whatever port is configured).

### For Production

Set the base URL in one of two ways:

**Option 1: Config file** (recommended)
```bash
agor config set daemon.base_url https://your-domain.com
```

**Option 2: Environment variable**
```bash
export AGOR_BASE_URL=https://your-domain.com
```

## Benefits

1. **Better UX**: Slack users can click directly to the session instead of manually navigating
2. **Reduced friction**: Makes it easier to switch between Slack and Agor UI
3. **Shareable**: URLs can be copied and shared with team members
4. **Configurable**: Works in both local development and production deployments

## Testing

The implementation has been verified to:
- ✓ Load configuration from `config.yaml`
- ✓ Support environment variable override
- ✓ Remove trailing slashes from URLs
- ✓ Generate correct session URLs in the format `/b/:boardId/:sessionId/`
- ✓ Handle missing board gracefully (fallback to old message)
- ✓ Include proper imports and type definitions

## Files Modified

1. `packages/core/src/config/types.ts` - Added `base_url` config option
2. `packages/core/src/config/config-manager.ts` - Added `getBaseUrl()` function
3. `apps/agor-daemon/src/services/gateway.ts` - Updated session creation to include URLs
4. `~/.agor/config.yaml` - Added base_url configuration

## Next Steps

The daemon will need to be restarted for the changes to take effect. The watch mode will automatically pick up the TypeScript changes in the gateway service.
