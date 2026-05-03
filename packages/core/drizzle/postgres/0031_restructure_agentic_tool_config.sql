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
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,claude-code,ANTHROPIC_API_KEY}',
  COALESCE(
    data->'api_keys'->'ANTHROPIC_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_API_KEY'->'value_encrypted'
    END
  ),
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'claude-code', '{}'::jsonb) ? 'ANTHROPIC_API_KEY')
  AND COALESCE(
    data->'api_keys'->'ANTHROPIC_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_API_KEY'->'value_encrypted'
    END
  ) IS NOT NULL;

-- claude-code: CLAUDE_CODE_OAUTH_TOKEN
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,claude-code,CLAUDE_CODE_OAUTH_TOKEN}',
  COALESCE(
    data->'api_keys'->'CLAUDE_CODE_OAUTH_TOKEN',
    CASE jsonb_typeof(data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'string' THEN data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN'
      WHEN 'object' THEN data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN'->'value_encrypted'
    END
  ),
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'claude-code', '{}'::jsonb) ? 'CLAUDE_CODE_OAUTH_TOKEN')
  AND COALESCE(
    data->'api_keys'->'CLAUDE_CODE_OAUTH_TOKEN',
    CASE jsonb_typeof(data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN')
      WHEN 'string' THEN data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN'
      WHEN 'object' THEN data->'env_vars'->'CLAUDE_CODE_OAUTH_TOKEN'->'value_encrypted'
    END
  ) IS NOT NULL;

-- claude-code: ANTHROPIC_BASE_URL  (env_vars only — was never in api_keys)
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,claude-code,ANTHROPIC_BASE_URL}',
  CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_BASE_URL')
    WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_BASE_URL'
    WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_BASE_URL'->'value_encrypted'
  END,
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'claude-code', '{}'::jsonb) ? 'ANTHROPIC_BASE_URL')
  AND CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_BASE_URL')
        WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_BASE_URL'
        WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_BASE_URL'->'value_encrypted'
        ELSE NULL
      END IS NOT NULL;

-- claude-code: ANTHROPIC_AUTH_TOKEN  (env_vars only)
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,claude-code,ANTHROPIC_AUTH_TOKEN}',
  CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_AUTH_TOKEN')
    WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_AUTH_TOKEN'
    WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_AUTH_TOKEN'->'value_encrypted'
  END,
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'claude-code', '{}'::jsonb) ? 'ANTHROPIC_AUTH_TOKEN')
  AND CASE jsonb_typeof(data->'env_vars'->'ANTHROPIC_AUTH_TOKEN')
        WHEN 'string' THEN data->'env_vars'->'ANTHROPIC_AUTH_TOKEN'
        WHEN 'object' THEN data->'env_vars'->'ANTHROPIC_AUTH_TOKEN'->'value_encrypted'
        ELSE NULL
      END IS NOT NULL;

-- codex: OPENAI_API_KEY
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,codex,OPENAI_API_KEY}',
  COALESCE(
    data->'api_keys'->'OPENAI_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'OPENAI_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'OPENAI_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'OPENAI_API_KEY'->'value_encrypted'
    END
  ),
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'codex', '{}'::jsonb) ? 'OPENAI_API_KEY')
  AND COALESCE(
    data->'api_keys'->'OPENAI_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'OPENAI_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'OPENAI_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'OPENAI_API_KEY'->'value_encrypted'
    END
  ) IS NOT NULL;

-- gemini: GEMINI_API_KEY
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,gemini,GEMINI_API_KEY}',
  COALESCE(
    data->'api_keys'->'GEMINI_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'GEMINI_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'GEMINI_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'GEMINI_API_KEY'->'value_encrypted'
    END
  ),
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'gemini', '{}'::jsonb) ? 'GEMINI_API_KEY')
  AND COALESCE(
    data->'api_keys'->'GEMINI_API_KEY',
    CASE jsonb_typeof(data->'env_vars'->'GEMINI_API_KEY')
      WHEN 'string' THEN data->'env_vars'->'GEMINI_API_KEY'
      WHEN 'object' THEN data->'env_vars'->'GEMINI_API_KEY'->'value_encrypted'
    END
  ) IS NOT NULL;

-- copilot: COPILOT_GITHUB_TOKEN
-- (Note: GH_TOKEN / GITHUB_TOKEN are intentionally NOT migrated — they have
--  legitimate non-Copilot uses (git, gh CLI). The Copilot SDK's own fallback
--  chain still picks them up at runtime if no per-tool token is set.)
UPDATE users SET data = jsonb_set(
  data,
  '{agentic_tools,copilot,COPILOT_GITHUB_TOKEN}',
  COALESCE(
    data->'api_keys'->'COPILOT_GITHUB_TOKEN',
    CASE jsonb_typeof(data->'env_vars'->'COPILOT_GITHUB_TOKEN')
      WHEN 'string' THEN data->'env_vars'->'COPILOT_GITHUB_TOKEN'
      WHEN 'object' THEN data->'env_vars'->'COPILOT_GITHUB_TOKEN'->'value_encrypted'
    END
  ),
  true
)
WHERE NOT (COALESCE(data->'agentic_tools'->'copilot', '{}'::jsonb) ? 'COPILOT_GITHUB_TOKEN')
  AND COALESCE(
    data->'api_keys'->'COPILOT_GITHUB_TOKEN',
    CASE jsonb_typeof(data->'env_vars'->'COPILOT_GITHUB_TOKEN')
      WHEN 'string' THEN data->'env_vars'->'COPILOT_GITHUB_TOKEN'
      WHEN 'object' THEN data->'env_vars'->'COPILOT_GITHUB_TOKEN'->'value_encrypted'
    END
  ) IS NOT NULL;

-- ============================================================
-- Cleanup: remove now-redundant source entries.
-- Each runs only if the corresponding target is verifiably populated.
-- ============================================================

-- claude-code: ANTHROPIC_API_KEY
UPDATE users SET data = (data #- '{api_keys,ANTHROPIC_API_KEY}') #- '{env_vars,ANTHROPIC_API_KEY}'
WHERE data->'agentic_tools'->'claude-code'->'ANTHROPIC_API_KEY' IS NOT NULL;

-- claude-code: CLAUDE_CODE_OAUTH_TOKEN
UPDATE users SET data = (data #- '{api_keys,CLAUDE_CODE_OAUTH_TOKEN}') #- '{env_vars,CLAUDE_CODE_OAUTH_TOKEN}'
WHERE data->'agentic_tools'->'claude-code'->'CLAUDE_CODE_OAUTH_TOKEN' IS NOT NULL;

-- claude-code: ANTHROPIC_BASE_URL
UPDATE users SET data = data #- '{env_vars,ANTHROPIC_BASE_URL}'
WHERE data->'agentic_tools'->'claude-code'->'ANTHROPIC_BASE_URL' IS NOT NULL;

-- claude-code: ANTHROPIC_AUTH_TOKEN
UPDATE users SET data = data #- '{env_vars,ANTHROPIC_AUTH_TOKEN}'
WHERE data->'agentic_tools'->'claude-code'->'ANTHROPIC_AUTH_TOKEN' IS NOT NULL;

-- codex: OPENAI_API_KEY
UPDATE users SET data = (data #- '{api_keys,OPENAI_API_KEY}') #- '{env_vars,OPENAI_API_KEY}'
WHERE data->'agentic_tools'->'codex'->'OPENAI_API_KEY' IS NOT NULL;

-- gemini: GEMINI_API_KEY
UPDATE users SET data = (data #- '{api_keys,GEMINI_API_KEY}') #- '{env_vars,GEMINI_API_KEY}'
WHERE data->'agentic_tools'->'gemini'->'GEMINI_API_KEY' IS NOT NULL;

-- copilot: COPILOT_GITHUB_TOKEN
UPDATE users SET data = (data #- '{api_keys,COPILOT_GITHUB_TOKEN}') #- '{env_vars,COPILOT_GITHUB_TOKEN}'
WHERE data->'agentic_tools'->'copilot'->'COPILOT_GITHUB_TOKEN' IS NOT NULL;
