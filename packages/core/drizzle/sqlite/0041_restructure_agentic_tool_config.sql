-- Restructure per-tool credentials into per-tool buckets.
--
-- Lifts encrypted credential strings from two legacy locations:
--   1. data.api_keys.<FIELD>                      (flat map, current PR's intermediate shape)
--   2. data.env_vars.<FIELD>                      (legacy plaintext form: string)
--   3. data.env_vars.<FIELD>.value_encrypted      (v0.5 object form)
--
-- ...into the new per-tool structure:
--   data.agentic_tools.<tool>.<FIELD>             (encrypted string, uniform shape)
--
-- Source priority is api_keys > env_vars (api_keys is more recently/explicitly set).
-- All values stay encrypted at rest — the runtime decrypts on read; URL-typed
-- fields are still stored as encrypted blobs for shape uniformity.
--
-- Idempotency: per-field lift is skipped if the target is already populated.
-- Non-destructive: source rows are only removed AFTER the target is verified
-- populated, so a partial run can be safely retried.

-- ============================================================
-- Lift step: agentic_tools.<tool>.<FIELD> ← api_keys/env_vars
-- ============================================================

-- claude-code: ANTHROPIC_API_KEY
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools."claude-code".ANTHROPIC_API_KEY',
  COALESCE(
    json_extract(data, '$.api_keys.ANTHROPIC_API_KEY'),
    CASE json_type(data, '$.env_vars.ANTHROPIC_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_API_KEY.value_encrypted')
    END
  )
)
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_API_KEY') IS NULL
  AND COALESCE(
    json_extract(data, '$.api_keys.ANTHROPIC_API_KEY'),
    CASE json_type(data, '$.env_vars.ANTHROPIC_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_API_KEY.value_encrypted')
    END
  ) IS NOT NULL;

-- claude-code: CLAUDE_CODE_OAUTH_TOKEN
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools."claude-code".CLAUDE_CODE_OAUTH_TOKEN',
  COALESCE(
    json_extract(data, '$.api_keys.CLAUDE_CODE_OAUTH_TOKEN'),
    CASE json_type(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'object' THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted')
    END
  )
)
WHERE json_extract(data, '$.agentic_tools."claude-code".CLAUDE_CODE_OAUTH_TOKEN') IS NULL
  AND COALESCE(
    json_extract(data, '$.api_keys.CLAUDE_CODE_OAUTH_TOKEN'),
    CASE json_type(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'object' THEN json_extract(data, '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted')
    END
  ) IS NOT NULL;

-- claude-code: ANTHROPIC_BASE_URL  (env_vars only — was never in api_keys)
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools."claude-code".ANTHROPIC_BASE_URL',
  CASE json_type(data, '$.env_vars.ANTHROPIC_BASE_URL')
    WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_BASE_URL')
    WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_BASE_URL.value_encrypted')
  END
)
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_BASE_URL') IS NULL
  AND CASE json_type(data, '$.env_vars.ANTHROPIC_BASE_URL')
        WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_BASE_URL')
        WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_BASE_URL.value_encrypted')
        ELSE NULL
      END IS NOT NULL;

-- claude-code: ANTHROPIC_AUTH_TOKEN  (env_vars only)
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools."claude-code".ANTHROPIC_AUTH_TOKEN',
  CASE json_type(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN')
    WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN')
    WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN.value_encrypted')
  END
)
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_AUTH_TOKEN') IS NULL
  AND CASE json_type(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN')
        WHEN 'text'   THEN json_extract(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN')
        WHEN 'object' THEN json_extract(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN.value_encrypted')
        ELSE NULL
      END IS NOT NULL;

-- codex: OPENAI_API_KEY
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools.codex.OPENAI_API_KEY',
  COALESCE(
    json_extract(data, '$.api_keys.OPENAI_API_KEY'),
    CASE json_type(data, '$.env_vars.OPENAI_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.OPENAI_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.OPENAI_API_KEY.value_encrypted')
    END
  )
)
WHERE json_extract(data, '$.agentic_tools.codex.OPENAI_API_KEY') IS NULL
  AND COALESCE(
    json_extract(data, '$.api_keys.OPENAI_API_KEY'),
    CASE json_type(data, '$.env_vars.OPENAI_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.OPENAI_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.OPENAI_API_KEY.value_encrypted')
    END
  ) IS NOT NULL;

-- gemini: GEMINI_API_KEY
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools.gemini.GEMINI_API_KEY',
  COALESCE(
    json_extract(data, '$.api_keys.GEMINI_API_KEY'),
    CASE json_type(data, '$.env_vars.GEMINI_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.GEMINI_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.GEMINI_API_KEY.value_encrypted')
    END
  )
)
WHERE json_extract(data, '$.agentic_tools.gemini.GEMINI_API_KEY') IS NULL
  AND COALESCE(
    json_extract(data, '$.api_keys.GEMINI_API_KEY'),
    CASE json_type(data, '$.env_vars.GEMINI_API_KEY')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.GEMINI_API_KEY')
      WHEN 'object' THEN json_extract(data, '$.env_vars.GEMINI_API_KEY.value_encrypted')
    END
  ) IS NOT NULL;

-- copilot: COPILOT_GITHUB_TOKEN
-- (Note: GH_TOKEN / GITHUB_TOKEN are intentionally NOT migrated — they have
--  legitimate non-Copilot uses (git, gh CLI). The Copilot SDK's own fallback
--  chain still picks them up at runtime if no per-tool token is set.)
UPDATE users SET data = json_set(
  data,
  '$.agentic_tools.copilot.COPILOT_GITHUB_TOKEN',
  COALESCE(
    json_extract(data, '$.api_keys.COPILOT_GITHUB_TOKEN'),
    CASE json_type(data, '$.env_vars.COPILOT_GITHUB_TOKEN')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.COPILOT_GITHUB_TOKEN')
      WHEN 'object' THEN json_extract(data, '$.env_vars.COPILOT_GITHUB_TOKEN.value_encrypted')
    END
  )
)
WHERE json_extract(data, '$.agentic_tools.copilot.COPILOT_GITHUB_TOKEN') IS NULL
  AND COALESCE(
    json_extract(data, '$.api_keys.COPILOT_GITHUB_TOKEN'),
    CASE json_type(data, '$.env_vars.COPILOT_GITHUB_TOKEN')
      WHEN 'text'   THEN json_extract(data, '$.env_vars.COPILOT_GITHUB_TOKEN')
      WHEN 'object' THEN json_extract(data, '$.env_vars.COPILOT_GITHUB_TOKEN.value_encrypted')
    END
  ) IS NOT NULL;

-- ============================================================
-- Cleanup: remove now-redundant source entries.
-- Each runs only if the corresponding target is verifiably populated.
-- ============================================================

-- claude-code: ANTHROPIC_API_KEY
UPDATE users SET data = json_remove(json_remove(data,
  '$.api_keys.ANTHROPIC_API_KEY'),
  '$.env_vars.ANTHROPIC_API_KEY')
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_API_KEY') IS NOT NULL;

-- claude-code: CLAUDE_CODE_OAUTH_TOKEN
UPDATE users SET data = json_remove(json_remove(data,
  '$.api_keys.CLAUDE_CODE_OAUTH_TOKEN'),
  '$.env_vars.CLAUDE_CODE_OAUTH_TOKEN')
WHERE json_extract(data, '$.agentic_tools."claude-code".CLAUDE_CODE_OAUTH_TOKEN') IS NOT NULL;

-- claude-code: ANTHROPIC_BASE_URL
UPDATE users SET data = json_remove(data, '$.env_vars.ANTHROPIC_BASE_URL')
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_BASE_URL') IS NOT NULL;

-- claude-code: ANTHROPIC_AUTH_TOKEN
UPDATE users SET data = json_remove(data, '$.env_vars.ANTHROPIC_AUTH_TOKEN')
WHERE json_extract(data, '$.agentic_tools."claude-code".ANTHROPIC_AUTH_TOKEN') IS NOT NULL;

-- codex: OPENAI_API_KEY
UPDATE users SET data = json_remove(json_remove(data,
  '$.api_keys.OPENAI_API_KEY'),
  '$.env_vars.OPENAI_API_KEY')
WHERE json_extract(data, '$.agentic_tools.codex.OPENAI_API_KEY') IS NOT NULL;

-- gemini: GEMINI_API_KEY
UPDATE users SET data = json_remove(json_remove(data,
  '$.api_keys.GEMINI_API_KEY'),
  '$.env_vars.GEMINI_API_KEY')
WHERE json_extract(data, '$.agentic_tools.gemini.GEMINI_API_KEY') IS NOT NULL;

-- copilot: COPILOT_GITHUB_TOKEN
UPDATE users SET data = json_remove(json_remove(data,
  '$.api_keys.COPILOT_GITHUB_TOKEN'),
  '$.env_vars.COPILOT_GITHUB_TOKEN')
WHERE json_extract(data, '$.agentic_tools.copilot.COPILOT_GITHUB_TOKEN') IS NOT NULL;
