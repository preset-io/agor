# Onboarding Wizard v2

**Status:** Exploration (future PR)
**Related:** [`apps/agor-ui/src/components/OnboardingWizard/`](../../apps/agor-ui/src/components/OnboardingWizard), [`apps/agor-docs/pages/guide/getting-started.mdx`](../../apps/agor-docs/pages/guide/getting-started.mdx), [`apps/agor-ui/src/components/ApiKeyFields.tsx`](../../apps/agor-ui/src/components/ApiKeyFields.tsx)

---

## Goal

The onboarding wizard's job is to **assist users in getting to their first assistant session, pre-prompted to set them up for success**. Today's wizard does the structural work (clone → board → worktree → API keys → launch) but leaves the user to figure out auth subtleties on their own and drops them into an empty session with no context. v2 should close those gaps so that the docs page can shrink to "follow the wizard."

This is the companion to the [Getting Started docs trim](../../apps/agor-docs/pages/guide/getting-started.mdx) — the docs were minified on the assumption that the wizard would grow up to handle every reasonable case.

---

## Today's friction (motivating examples)

These came up walking through the flow on a real Docker install:

1. **Claude Max/Pro plan + Docker.** No `claude` CLI in the container, no `~/.claude/credentials.json` mounted. The wizard's info banner says "if the system user is already authed with the `claude` CLI, you can skip" — but offers no way to actually *get* authed. The user knows they have a Max plan, but the only affordances are "paste an API key" or "Skip for now". The real answer (`claude setup-token` on host → paste token into User Settings → Env vars as `CLAUDE_CODE_OAUTH_TOKEN`) is documented but not surfaced.

2. **Codex default permission profile blocks MCP.** Codex CLI's default `workspace-write` profile has MCP set to `on-request`, which means Agor's own MCP server prompts on every call. That undermines the "anything a user can do, the agent can do too" framing — the agent can't actually use Agor's tools without manual approval. Agor's Codex bootstrap should pre-approve its internal MCP server.

3. **No first-session context.** After Launch, the user is in an empty conversation. The assistant has no system message telling it that this is a new user's first contact, so the warmth and tour you'd want from "OpenClaw for teams" doesn't happen by default.

---

## v2 design goals

### 1. Narrow the recommended surface

- **Tier-1 (well-tested):** Claude Code + Codex. These are what we test against and recommend.
- **Tier-2 (allowed but unrecommended):** Gemini, OpenCode, Copilot. Available in the dropdown but with a clear "less tested" indicator.

### 2. Auth that actually works for both tiers

For Claude Code and Codex, the API Keys step should offer **two paths each**:

- **Subscription plan** — Claude Max/Pro for Claude Code, ChatGPT Plus/Pro for Codex.
- **API key** — paste-a-key fallback.

For each path, the wizard should:

- **Verify the CLI is present** in the daemon's execution environment. If not, give a one-line install command (or, for the subscription path, walk through `claude setup-token` with a paste field for the resulting token).
- **Verify auth actually works** — call the CLI's whoami / status equivalent and surface the result. Something like:
  > ✓ Detected `claude` v1.0.x — already authenticated as `user@example.com`
  > ✗ `claude` installed but not authenticated. [Run `claude setup-token`]

- **Detect existing auth state** before showing the input — if creds already work, show a green check + Continue, skip the form.

This collapses the docs' three Authentication options (per-user keys, CLI login, env-var fallback) into a single guided UI that picks the right one for the user's environment.

### 3. Permission mode that supports MCP out of the box

For Claude Code: ensure the session config exposes Agor's internal MCP server with appropriate auto-approval.

For Codex: override the default profile so Agor's MCP server is pre-approved (NOT user-installed third-party MCPs — only Agor's own, on the rationale that Agor *is* the host environment). Show a small disclaimer banner so the user sees what's been approved.

This should also apply to other Tier-1 capabilities the agent will need — file access scope, tool approval mode, etc. — all set to sensible "you're in Agor, this just works" defaults.

### 4. Smart pre-prompt on first session

Before the user types anything, inject an Agor system message that primes the assistant for the onboarding role. Sketch:

> [Agor system message] You are assisting a user in their first Agor session. They may be new to Agor Assistants, how they operate, and possibly to Agor itself.
>
> Boot up by:
> 1. Introducing yourself briefly — Agor assistants pick a name and emoji.
> 2. Offering to define your identity together (name, emoji, role) — keep it light.
> 3. Asking who they are, what they do, and what they'd like to get started on.
> 4. Offering a short tour of Agor's capabilities — boards, worktrees, sessions, MCP — and tailoring it to what they want.
>
> You have full access to the Agor MCP server. Anything the user can do in the UI, you can do too: create repos, set up boards and zones, spawn worktrees, schedule sessions, etc.
>
> Treat this as the warm handoff from the onboarding wizard. The wizard got them into this seat. Your job is to make them feel oriented and capable.

The exact wording needs iteration, but the principle is: **the wizard's last step is loading a system message that turns the assistant into a thoughtful host.** No empty-textbox cold start.

---

## Implementation sketch

- **Wizard refactor** (`apps/agor-ui/src/components/OnboardingWizard/`):
  - Replace API Keys step with a per-agent multi-tab UI: `[ Subscription | API Key | Already authed ]`
  - New daemon-side "preflight" endpoint: `POST /agentic-tools/preflight` → returns `{ cli_installed, cli_version, auth_status, auth_identity? }` per agent
  - "Skip for now" stays, but is downplayed once preflight is wired

- **Codex MCP defaults** (executor / SDK integration layer):
  - In `apps/agor-daemon/` (or wherever Codex sessions are bootstrapped), inject a Codex profile that pre-approves Agor's internal MCP server URL
  - User-added MCP servers stay on whatever the user configured

- **First-session pre-prompt** (executor / session creation):
  - Add an "is_first_assistant_session" flag at user level (default true; flips on first session creation under the assistant repo)
  - On launch, when the flag is true, prepend an Agor system message before the user's first turn
  - Make the prompt template editable in `~/.agor/config.yaml` for custom Agor deployments (e.g. enterprise has its own onboarding tone)

- **Docs implication:**
  - `apps/agor-docs/pages/guide/getting-started.mdx` already trimmed on the assumption v2 ships. If v2 slips, the page may need a paragraph patching the gaps it leaves.

---

## Out of scope for v2 (later)

- **Bundling the agent CLIs.** Don't. Different release cadences, different licenses, large binaries, and they evolve their own auth flows. Detect-and-link, don't bundle.
- **Multi-user onboarding.** v2 assumes single user signing up the first time. Per-user re-onboarding (when a teammate joins an existing instance) is a different problem — different defaults, different tone.
- **Org-level onboarding.** "Set up Agor for your team" is its own flow with RBAC, Unix isolation, and Postgres. That belongs alongside the deployment-mode work, not here.

---

## Success criteria

- A new user with a Claude Max plan, running Agor in Docker, can complete onboarding and have their first agent session use their subscription **without reading any docs**.
- The same user, switching to Codex, has Agor's MCP server working from the first message — no per-call approvals.
- The first message in their first session is the assistant warmly introducing itself, not a blank cursor.

If those three things are true, the Getting Started docs page can stay at its current trimmed length forever.
