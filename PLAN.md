# Rename "Persisted Agents" → "Assistants" — Plan

## Audit: Complete Inventory

### Core Types (`packages/core/`)

| File | What | Line(s) |
|------|------|---------|
| `src/types/worktree.ts` | `PersistedAgentConfig` interface | 590 |
| `src/types/worktree.ts` | `isPersistedAgent()` function | 606 |
| `src/types/worktree.ts` | `getPersistedAgentConfig()` function | 618 |
| `src/types/worktree.ts` | `kind: 'persisted-agent'` discriminator | 592 |
| `src/types/worktree.ts` | `custom_context.agent` access pattern | 607, 622 |
| `src/config/types.ts` | `AgorOnboardingSettings.persistedAgentPending` | 324 |
| `src/config/types.ts` | Comments: "persisted agent setup" | 323 |

### UI Components (`apps/agor-ui/`)

| File | What |
|------|------|
| `components/SettingsModal/AgentsTable.tsx` | Full component: `AgentsTable`, `AgentsTableProps`, `OPENCLAW_REPO_SLUG`, all "Agent" UI strings |
| `components/SettingsModal/SettingsModal.tsx` | Menu item `key: 'agents'`, label `'Agents'`, import of `AgentsTable` |
| `components/SettingsModal/WorktreesTable.tsx` | `isPersistedAgent` import, filter `archiveFilter === 'agents'`, label `'Agents'` |
| `components/SettingsModal/WorktreeEnvColumn.tsx` | Comment: "Used by both WorktreesTable and AgentsTable" |
| `components/WorktreeModal/WorktreeModal.tsx` | `isAgent`, `agentConfig`, tab `key: 'agent'`, label `'Agent'`, title `'Agent: ...'`, import of `AgentTab` |
| `components/WorktreeModal/tabs/AgentTab.tsx` | Full component: `AgentTab`, `AgentTabProps`, all "Agent" UI strings |
| `components/WorktreeCard/WorktreeCard.tsx` | `isAgent`, `agentConfig` variables |
| `components/OnboardingWizard/OnboardingWizard.tsx` | `OPENCLAW_REPO_URL`, `OPENCLAW_REPO_SLUG`, `WizardPath = 'persisted-agent'`, `PersistedAgentConfig` import, "Persisted Agent" UI strings, "agor-openclaw" references |
| `hooks/useAuthConfig.ts` | `OnboardingConfig.persistedAgentPending` |
| `App.tsx` | `persistedAgentPending` prop pass-through, `'persisted-agent'` path check |

### CLI (`apps/agor-cli/`)

| File | What |
|------|------|
| `commands/init.ts` | `promptPersistedAgent()`, "Persisted Agent" UI strings, `setupPersistedAgent` variable, `agor-openclaw` URL, `persistedAgentPending` config |

### Daemon (`apps/agor-daemon/`)

| File | What |
|------|------|
| `src/index.ts` | `persistedAgentPending` in health endpoint response |
| `src/services/config.ts` | `persistedAgentPending` config update handler |

### Docs (`apps/agor-docs/`)

| File | What |
|------|------|
| `pages/blog/_meta.ts` | `'agor-openclaw'` and `openclaw` keys |
| `pages/blog/agor-openclaw.mdx` | Entire blog post about Agor-OpenClaw |
| `pages/blog/openclaw.mdx` | Entire blog post: "Agor vs. OpenClaw (ClawdBot)" |
| `pages/guide/concepts.mdx` | No assistant concept documented yet |
| `pages/guide/_meta.ts` | No assistant entry |
| `pages/guide/message-gateway.mdx` | References to `agor-openclaw` worktree |

### Database / Stored Data

- `custom_context.agent` field in worktree JSON — stores `PersistedAgentConfig`
- `kind: 'persisted-agent'` discriminator value in stored JSON
- `config.yaml` → `onboarding.persistedAgentPending` flag

---

## Naming Disambiguation

**"Assistant"** = persistent AI companion with memory, orchestration, heartbeats (what was "Persisted Agent")
**"Agent"** = execution engine (claude-code, codex, gemini, opencode) — does NOT change

These are NOT renamed:
- `AgenticToolName`, `agentic_tool`, `agenticTool` — execution engine type
- `selectedAgent` in API key setup — refers to which execution engine
- `AGENT_LABELS`, `AGENT_KEY_CONSOLES` — execution engine names
- `apiKeyNameForAgent()` — execution engine helper

---

## Phased Plan

### Phase 1 (THIS PR): Core rename + documentation

**Types & Code:**
- `PersistedAgentConfig` → `AssistantConfig`
- `isPersistedAgent()` → `isAssistant()`
- `getPersistedAgentConfig()` → `getAssistantConfig()`
- `kind: 'persisted-agent'` → `kind: 'assistant'` (with backward compat check for `'persisted-agent'`)
- `custom_context.agent` → keep as `custom_context.assistant` (rename with backward compat read)
- `AgentsTable.tsx` → `AssistantsTable.tsx`
- `AgentTab.tsx` → `AssistantTab.tsx`
- `AgentsTableProps` → `AssistantsTableProps`
- `AgentTabProps` → `AssistantTabProps`
- `persistedAgentPending` → `assistantPending` (config + onboarding)
- `WizardPath = 'persisted-agent'` → `'assistant'`

**UI Strings:**
- Settings menu: "Agents" → "Assistants"
- Settings case: `'agents'` → `'assistants'`
- "Create Agent" → "Create Assistant"
- "Agent: {name}" → "Assistant: {name}"
- "Edit agent" / "Delete agent" → "Edit assistant" / "Delete assistant"
- "No agents yet" → "No assistants yet"
- "Search agents..." → "Search assistants..."
- "Agent Configuration" → "Assistant Configuration"
- "Agent updated" → "Assistant updated"
- "Agent display name" placeholder → "Assistant display name"
- "Persisted agents are long-lived worktrees..." → updated description
- "Create a persisted agent to get started..." → updated
- "board for this agent" → "board for this assistant"
- "agents can act across boards" → "assistants can act across boards"
- "Human-friendly name for this agent" → "... for this assistant"
- "private-my-agent" → "private-my-assistant"
- WorktreesTable filter label: "Agents" → "Assistants"
- OnboardingWizard: "Set up your persisted agent" → "Set up your assistant"
- "Clone the agor-openclaw workspace..." → "Clone the assistant framework..."
- "Cloning agor-openclaw repository..." → "Cloning assistant framework..."
- "agor-openclaw has been cloned successfully." → "Assistant framework cloned successfully."
- "Your persisted agent is set up..." → "Your assistant is set up..."
- "Say hello to your agent!" → "Say hello to your assistant!"
- "...agent has been waiting their whole life to meet you" → "...assistant..."
- CLI init: "Persisted Agent" → "Assistant", all related strings

**Documentation:**
- Add "Assistants" section to `concepts.mdx`
- Update `message-gateway.mdx` references

**NOT touched in Phase 1:**
- Blog posts (Phase 3)
- Blog _meta.ts (Phase 3)
- Framework repo URL `agor-openclaw` (Phase 4)
- `OPENCLAW_REPO_SLUG`/`OPENCLAW_REPO_URL` constants stay (Phase 4)

### Phase 2 (follow-up PR): Visual distinction for WorktreeCard
- Add `mode="assistant"` to WorktreeCard
- Distinct card design: different background/border, icon, title treatment
- Heartbeat scheduler prompt
- Design polish

### Phase 3 (follow-up PR): Blog + docs refinement
- Write new blog post introducing "Assistants"
- Archive/update "Agor OpenClaw" blog posts
- Improve concepts documentation from real usage

### Phase 4 (separate effort): Repository rename
- Rename `mistercrunch/agor-openclaw` → `preset-io/agor-assistant`
- Update `OPENCLAW_REPO_URL`, `OPENCLAW_REPO_SLUG` constants
- Update all framework repo detection logic
- Improve assistant template repo

---

## Backward Compatibility Strategy

### `custom_context.agent` → `custom_context.assistant`

The `isAssistant()` type guard will check **both** `custom_context.assistant` and `custom_context.agent` for backward compatibility with existing worktrees. New worktrees will write to `custom_context.assistant`.

### `kind: 'persisted-agent'` → `kind: 'assistant'`

Similarly, the type guard will accept both `'assistant'` and `'persisted-agent'` as valid kind values. New assistants will use `kind: 'assistant'`.

### `persistedAgentPending` → `assistantPending`

Both the config key and onboarding flag will be renamed. The config reader will check both old and new key names for backward compat.
