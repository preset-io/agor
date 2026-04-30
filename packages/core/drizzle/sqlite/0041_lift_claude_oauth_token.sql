-- Lift CLAUDE_CODE_OAUTH_TOKEN from users.data.env_vars into users.data.api_keys.
--
-- Rationale: the Claude Code Pro/Max subscription token was previously stored
-- as a generic env var, which is awkward for users (a magic string they have
-- to know) and inconsistent with how other tool credentials live (already in
-- api_keys). This migration is a pure structural lift — the encrypted byte
-- string moves verbatim, no re-encryption.
--
-- Handles two source shapes:
--   - Legacy plaintext: env_vars.CLAUDE_CODE_OAUTH_TOKEN is the encrypted
--     string directly (pre v0.5 storage shape).
--   - v0.5 object form:  env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted
--     holds the encrypted string alongside scope metadata.
--
-- The WHERE clause makes the migration idempotent: if api_keys.CLAUDE_CODE_OAUTH_TOKEN
-- is already set (or the env var entry is absent), the row is left alone.
UPDATE users
SET data = json_remove(
  json_set(
    data,
    '$.api_keys.CLAUDE_CODE_OAUTH_TOKEN',
    CASE json_type(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'object' THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted')
    END
  ),
  '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN'
)
WHERE json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN') IS NOT NULL
  AND json_extract(data, '$.api_keys.CLAUDE_CODE_OAUTH_TOKEN') IS NULL
  AND CASE json_type(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
        WHEN 'text'   THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
        WHEN 'object' THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted')
        ELSE NULL
      END IS NOT NULL;
