# Design: GitHub App Integration for Agor

**Status:** Draft
**Author:** Design research session
**Date:** 2026-03-29

---

## Executive Summary

This document designs a GitHub integration for Agor that creates **persistent, observable, post-promptable sessions** when users interact with PRs — fundamentally different from Claude Code's ephemeral GHA-based approach. Each org creates their own **GitHub App** (via manifest template or manually), connected via a gateway channel (type: `github`) that routes `@agor` mentions to sessions. Agor polls the GitHub API (all outbound, works behind any VPN) and provides the **routing infrastructure** — the intelligence (what to do when mentioned, how to review PRs, etc.) is configured by the admin via an Agor Assistant. **No GitHub Actions, webhooks, shared apps, or inbound connections required.**

---

## Table of Contents

1. [Competitive Landscape](#1-competitive-landscape)
2. [The Agor GitHub App](#2-the-agor-github-app)
3. [Recommended Architecture](#3-recommended-architecture)
4. [Session Lifecycle](#4-session-lifecycle)
5. [VPN / Private Network Solutions](#5-vpn--private-network-solutions)
6. [GitHub Connector Design](#6-github-connector-design)
7. [User Identity & Permissions](#7-user-identity--permissions)
8. [Coordinator Integration](#8-coordinator-integration)
9. [Implementation Phases](#9-implementation-phases)
10. [Open Questions](#10-open-questions)

---

## 1. Competitive Landscape

### How Others Do It

| Product | Architecture | Session Model | Trigger |
|---------|-------------|---------------|---------|
| **Claude Code Action** | GHA runner (full agent in VM) | Ephemeral per run | `@claude` in PR comment |
| **GitHub Copilot Agent** | GHA runner | Ephemeral per run | Assign issue to Copilot |
| **CodeRabbit** | Webhook → Cloud Run workers | Ephemeral per review | Webhook on PR events |
| **Agor (proposed)** | GitHub App + polling → persistent session | **Persistent & promptable** | `@agor` in PR comment |

### Claude Code's Approach (What We're Differentiating From)

Claude Code's GitHub integration (`anthropics/claude-code-action`) runs the **full Claude Code runtime inside a GHA runner VM**:

```
PR Comment (@claude) → GHA workflow triggers → Runner spins up
  → Checks out repo → Runs Claude Code agent → Posts results → Runner dies
```

Key characteristics:
- **No persistent server** — all compute on GitHub's infrastructure
- **Stateless** — each `@claude` mention starts fresh (context from PR thread only)
- **GitHub App is thin** — only provides auth tokens, no webhook processing
- **Installation via `/install-github-app`** — scaffolds a `.github/workflows/claude.yml`

### Agor's Key Differentiator

Agor sessions are **not fire-and-forget**. When `@agor` is mentioned on a PR:

1. A session appears on the Agor board — **visible and spatial**
2. The session has full MCP access, memory, and coordinator awareness
3. Anyone can watch the agent work in real-time on the canvas
4. Follow-up prompts can come from GitHub comments OR the Agor UI
5. The session persists — it can be resumed, forked, or referenced later
6. Multiple sessions on the same PR share context through the coordinator

This is the difference between "CI that happens to use AI" and "an orchestration platform that connects to GitHub."

---

## 2. The Agor GitHub App

### What Is a GitHub App?

A GitHub App is a first-class integration registered on GitHub that gets:
- **Installation tokens** — API access scoped to specific orgs/repos
- **Bot identity** — posts as `agor[bot]` with its own avatar
- **Fine-grained permissions** — only requests what it needs (PR read/write, contents read, etc.)
- **Event subscriptions** — can receive webhooks OR poll the API
- **Marketplace listing** — discoverable and installable by any GitHub user

Crucially, **webhooks are optional** when creating a GitHub App. You can create an app that only uses the API — no inbound URL, no webhook handler, no public endpoint.

### Why Not GitHub Actions?

GitHub Actions requires either:
- A GHA runner that can reach Agor (VPN problem), or
- The full agent to run ephemerally on a GHA VM (Claude Code's stateless model)

Neither fits Agor's model of persistent, observable sessions. A GitHub App with API polling gives us everything we need with zero network complexity.

### GitHub Has No Socket Mode

Unlike Slack (which has Socket Mode — a production-grade WebSocket where Slack pushes events to your server with no public URL needed), **GitHub has no equivalent**. The only two production mechanisms for receiving events are:

| Mechanism | Requires Public Endpoint | Latency | Production-Ready |
|-----------|:---:|---------|:---:|
| **Webhooks** (HTTP POST from GitHub) | Yes | ~1-5s | Yes |
| **API Polling** (outbound HTTPS from Agor) | **No** | 10-30s (your interval) | Yes |
| GraphQL Subscriptions | — | — | **Don't exist** |
| WebSocket/SSE streaming | — | — | **Don't exist** |

Polling is the only option that works behind a VPN without tunnels or config hell.

### How Polling Works (Efficiently)

```
Agor Assistant polls every 10-30 seconds:
  GET /repos/:owner/:repo/issues/comments?since=2026-03-29T12:00:00Z
  Header: If-None-Match: "<etag-from-last-request>"
    │
    ├── 304 Not Modified → no new comments, costs 0 rate limit
    └── 200 OK → new comments found
          │
          ├── Filter for @agor mentions
          ├── Deduplicate (track processed comment IDs)
          └── Route to assistant for handling
```

- **Rate limit friendly**: 304 responses don't count against the 5,000 req/hour limit
- **`since` parameter**: only returns comments after last poll timestamp
- **ETag caching**: GitHub returns `ETag` header, conditional requests are free
- **10-30s latency is fine** for PR reviews — nobody expects instant response

### Architecture: All Outbound

```
Behind VPN / Private Network              Public Internet
┌────────────────────────────┐          ┌──────────────────────┐
│                            │          │                      │
│  Agor Daemon               │  ──────→ │  api.github.com      │
│                            │  polls   │                      │
│  ┌──────────────────────┐  │          │  ┌────────────────┐  │
│  │ Agor Assistant       │  │  ──────→ │  │ Agor GitHub App│  │
│  │ (GitHub handler)     │  │  posts   │  │ (installed on   │  │
│  │                      │  │  results │  │  org/repo)      │  │
│  └──────────────────────┘  │          │  └────────────────┘  │
│                            │          │                      │
└────────────────────────────┘          └──────────────────────┘

All connections are OUTBOUND from Agor.
No inbound firewall rules. No tunnels. No VPN bridging.
GitHub App created with webhooks DISABLED.
```

### Installation Scope

GitHub Apps install **per-org** (or per-personal-account), with a repo filter:

```
Install on org "preset-io"
  ↓
Choose: ○ All repositories (including future ones)
        ● Only select repositories
          ☑ preset-io/agor
          ☑ preset-io/superset
          ☐ preset-io/other-repo
```

- Each installation gets a unique **Installation ID** (Agor stores this)
- Repo selection can be changed anytime after installation
- Permissions are set at the app level (same for all installations)
- One installation per org — not per-repo

### Setup Flow (GUI-First)

Since Agor is self-hosted infrastructure (not a SaaS), each org creates their **own GitHub App**. No shared app, no centralized private key, no trust delegation.

The setup flow lives in the **Agor UI** as part of the gateway channel creation modal. The daemon hosts the manifest callback endpoint directly — no CLI intermediary needed.

#### Step 1: Create or Reference a GitHub App

Two paths in the UI:

**Path A: "Create via GitHub" (manifest flow)**
```
UI: "Create GitHub App" button
  → Daemon serves auto-submit form at /api/github/manifest
  → Browser POSTs manifest to github.com/settings/apps/new
  → User names the app (default: "Agor") → clicks "Create"
  → GitHub redirects to daemon at /api/github/manifest/callback?code=XXXX
  → Daemon exchanges code for credentials (app_id, PEM, webhook_secret)
  → Daemon stores credentials, redirects to UI
  → UI shows: "✓ App created!"
```

**Path B: "I have an existing GitHub App"**
```
UI: Form fields for app_id, private_key (PEM), webhook_secret
  → User pastes credentials from their existing app
  → Validates via test API call
```

#### Step 2: Install the App on Org/Repos

```
UI: "Install on GitHub" link → opens github.com/apps/{slug}/installations/new
  → User selects org + repos → clicks "Install" (unavoidable manual step)
  → Daemon polls GET /app/installations to discover installation_id
  → OR user pastes installation_id manually
  → UI shows: "✓ Connected to preset-io (5 repos)"
```

#### Step 3: Configure the Gateway Channel

```
UI: Gateway channel config form
  → Select target worktree (for the assistant)
  → Agentic settings (model, MCPs, permissions)
  → Watch repos: "All repos" / specific repo selector
  → Poll interval (default: 15s)
  → Mention keyword (default: @agor)
  → User alignment (map GitHub users → Agor users)
  → Save → polling starts
```

The form has nice affordances that CLI can't match: dropdowns for worktree selection, repo accumulator pattern for watch_repos, real-time validation, agentic config presets.

#### CLI Alternative

A CLI command (`agor github setup`) can wrap the same daemon endpoints for headless/CI environments, but the GUI is the primary experience.

### The Manifest (Agor's App Template)

```json
{
  "name": "Agor",
  "description": "Agor AI coding assistant — persistent, observable PR reviews",
  "url": "https://agor.live",
  "hook_attributes": {
    "url": "https://example.com/webhook",
    "active": false
  },
  "public": false,
  "default_permissions": {
    "contents": "write",
    "issues": "write",
    "pull_requests": "write",
    "metadata": "read"
  },
  "default_events": [
    "issue_comment",
    "issues",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment"
  ]
}
```

Note: `hook_attributes.active: false` — webhooks disabled by default (polling mode). Users can enable webhooks later by updating their app settings and configuring the webhook URL to point at their Agor instance.

### Why Manifest-Per-Org, Not a Shared App

| Concern | Shared App (SaaS model) | Manifest Per-Org (self-hosted model) |
|---------|:---:|:---:|
| Who holds the private key | Agor centrally | Each org |
| Trust requirement | Must trust Agor with repo access | No trust delegation |
| Traffic routing | All orgs through one app | Each org independent |
| Webhook URL | One URL, can't fan out | Each app has its own URL |
| GitHub Enterprise Server | Doesn't work (GHES can't reach github.com apps) | Works (app registered on GHES) |
| Same org, two instances | Impossible | Works (two different apps) |
| Fits Agor's model | No (Agor is self-hosted) | **Yes** |

### How This Differs From Claude Code

| Step | Claude Code | Agor |
|------|------------|------|
| App creation | Shared app (`github.com/apps/claude`) OR custom via manifest | **Always custom via manifest** |
| Add API key as secret | Required (GitHub Secret) | Not needed (key on Agor server) |
| Create workflow file | Required (`.github/workflows/claude.yml`) | **Not needed** |
| Per-repo config | Optional (CLAUDE.md) | Optional (`.github/agor.yml`) |
| What the app does | Auth token provider only | Auth tokens + bot identity + polling |
| What runs the agent | GHA runner (ephemeral VM) | Agor server (persistent assistant) |
| Setup automation | `/install-github-app` CLI | UI wizard (daemon-hosted manifest flow) |

### Where Configuration Lives

**Layer 1: Agor gateway channel** (primary, stored in Agor DB):
- GitHub App credentials (installation_id, or app_id + private_key for custom apps)
- Polling interval, user alignment settings
- Agentic config (model, MCPs, permission mode)
- Target worktree/board for the assistant

**Layer 2: Per-repo `.github/agor.yml`** (optional, in the repo):
- Auto-review on PR open (true/false)
- Excluded paths, review scope
- Custom mention keyword (default: `@agor`)
- The connector reads this via Contents API — same pattern as Dependabot/Renovate/CodeRabbit

**Layer 3: GitHub installation settings** (minimal):
- Repo selection (all vs. specific repos)
- That's about it — GitHub stores almost nothing configurable

### GitHub App Permissions Required

| Permission | Access | Reason |
|-----------|--------|--------|
| Contents | Read (& Write for suggestions) | Read code, optionally push suggestions |
| Pull Requests | Read & Write | Read PRs, post comments, post reviews |
| Issues | Read & Write | Respond to issue comments |
| Metadata | Read | Repository info, user info |

### Webhook as Optional Upgrade

For instances with public endpoints, webhooks can be **enabled on the same app** for instant delivery:

```
Default: Polling (works everywhere, zero config)
  ↓ opt-in (flip a switch in Agor settings)
Upgrade: Webhooks (instant delivery, requires reachable endpoint)
  - User adds webhook URL to their GitHub App settings
  - Agor connector switches from poll loop to webhook handler
  - Same assistant, same flow, just instant trigger
```

---

## 3. Recommended Architecture: The Agor Assistant Model

### Core Insight: The Gateway Routes to an Assistant, Not Ephemeral Sessions

The gateway channel (type: `github`) doesn't create a fresh session per PR event. Instead, it routes all events to a **persistent Agor Assistant** — a long-running, stateful agent that acts as the "GitHub handler" for a repo. This assistant:

- **Receives all GitHub events** for a repo via the gateway channel
- **Routes by PR/issue context** to the right child session (or creates one)
- **Creates worktrees** pointing to the right branch for each PR
- **Spawns remote agents** on those worktrees to do the actual work
- **Accumulates memory** and knowledge across all PR interactions
- **Develops expertise** on the codebase over time (review patterns, conventions, common issues)

This is the same pattern that makes Slack gateway channels powerful: the channel routes to a worktree with an Agor Assistant, which then orchestrates work.

### High-Level Flow

```
                     ┌──────────────────────────────┐
                     │     GitHub Platform           │
                     │                               │
                     │  ┌─────────────────────┐      │
                     │  │ PR #42              │      │
                     │  │ @agor review this   │      │
                     │  └─────────────────────┘      │
                     │           │                    │
                     │  ┌────────┴────────┐           │
                     │  │  GitHub App     │           │
                     │  │  (installed on  │           │
                     │  │   org/repo)     │           │
                     │  └────────┬────────┘           │
                     └───────────┼────────────────────┘
                                 │
                    ┌────────────┼─────────────────┐
                    │   Agor polls API (outbound)   │
                    │   Agor posts results (outbound)│
                    └────────────┼─────────────────┘
                                 │
    ┌────────────────────────────┼───── behind VPN ──────────┐
    │  Agor Daemon               │                           │
    │                            ▼                           │
    │  ┌─────────────────────────────────────────────┐       │
    │  │  Agor Assistant (persistent GitHub handler) │       │
    │  │  - Polls GitHub API for @agor mentions      │       │
    │  │  - Has memory system (learns the codebase)  │       │
    │  │  - Routes events by PR/issue context        │       │
    │  │  - Lives on a "home" worktree for the repo  │       │
    │  └──────┬──────────────────┬──────────────────┘       │
    │         │                  │                           │
    │    creates worktree    spawns agent                    │
    │    for PR branch       on worktree                    │
    │         │                  │                           │
    │         ▼                  ▼                           │
    │  ┌──────────────┐  ┌────────────────────────┐         │
    │  │  Worktree    │  │  Child Session         │         │
    │  │  (PR branch) │← │  (does the actual      │         │
    │  │  on board    │  │   review/coding work)  │         │
    │  └──────────────┘  └────────────────────────┘         │
    └───────────────────────────────────────────────────────┘
                    │
                    │ posts results via GitHub API (outbound)
                    ▼
                     ┌──────────────────────────────┐
                     │     GitHub Platform           │
                     │  ┌─────────────────────┐      │
                     │  │ PR #42              │      │
                     │  │ [Agor Bot]:         │      │
                     │  │ Review complete...  │      │
                     │  └─────────────────────┘      │
                     └──────────────────────────────┘
```

**All connections are outbound from Agor.** No inbound firewall rules, tunnels, or VPN bridging needed.

### The Assistant's Role

The Agor Assistant is **not** the agent that reads code and writes reviews. It's the **coordinator** that:

1. **Receives** the GitHub event via gateway
2. **Decides** what to do (create new session? route to existing? ignore?)
3. **Creates a worktree** for the PR branch (if needed)
4. **Spawns a child agent** on that worktree with the right context
5. **Relays results** from the child back to GitHub via the connector
6. **Tracks state** — which PRs have active sessions, what's been reviewed, etc.
7. **Learns** — accumulates knowledge about the repo, review patterns, common issues

### What the Gateway Channel Provides

Gateway channels already have great affordances for this:

| Affordance | How It's Used |
|-----------|--------------|
| `target_worktree_id` | Points to the assistant's "home" worktree |
| `agentic_config` | Configures the assistant's agent type, model, MCPs |
| `agentic_config.mcpServerIds` | GitHub MCP server for API access |
| `config` (encrypted) | GitHub App credentials (app_id, private_key, etc.) |
| `agor_user_id` | The Agor user who owns the channel |
| `align_github_users` | Map GitHub commenter → Agor user |
| Thread-Session Map | Routes PR#42 → the child session handling that PR |

### What Gets Created

**Once, at channel setup:**
- Gateway channel (type: `github`) with GitHub App credentials
- Agor Assistant session on the target worktree (the "home" for this repo)
- The assistant starts and stays alive

**Per PR (first `@agor` mention):**
1. Assistant receives the event
2. Assistant creates a worktree for the PR's head branch
3. Assistant spawns a child session on that worktree
4. Thread-Session Map: `preset-io/agor#42` → child session ID
5. Child session appears on the board (spatial, observable)

**Per follow-up (`@agor` again on same PR):**
1. Gateway routes to existing thread-session mapping
2. New prompt sent to the **same child session** — full context preserved

### Webhook Endpoint

```
POST /gateway
{
  "channel_key": "<uuid>",        // Auth key for this GitHub channel
  "thread_id": "owner/repo#42",   // PR identifier as thread ID
  "text": "review this PR",       // Comment body (minus @agor prefix)
  "metadata": {
    "github_user": "maxdotio",
    "github_user_email": "max@preset.io",
    "event_type": "issue_comment",
    "pr_number": 42,
    "pr_url": "https://github.com/preset-io/agor/pull/42",
    "pr_title": "Add dark mode support",
    "pr_diff_url": "https://github.com/preset-io/agor/pull/42.diff",
    "comment_id": 123456789,
    "repo_full_name": "preset-io/agor",
    "action": "created"
  }
}
```

This fits exactly into the existing gateway service's `create()` method — the same flow that Slack uses.

---

## 4. Session Lifecycle

### Phase 1: Trigger & Routing

```
User comments "@agor review this PR" on GitHub PR #42
  ↓
Agor Assistant polls GitHub API (or receives webhook, if configured)
  ↓
GitHubConnector detects new @agor mention
  ↓
Extracts: repo, PR number, comment body, commenter identity
  ↓
Checks ThreadSessionMap: is PR#42 already mapped to a child session?
  ├── YES → route prompt to existing child session
  └── NO → assistant handles it (creates worktree, spawns child)
```

### Phase 2: Assistant Orchestrates

```
Agor Assistant (persistent GitHub handler) receives the event
  ↓
"New PR #42 from maxdotio: 'review this PR'"
  ↓
Assistant decides what to do:
  1. Fetches PR metadata via GitHub MCP/API (diff, description, files changed)
  2. Creates a worktree for the PR's head branch
     - `git worktree add` for the PR ref
     - Places worktree on the configured board
  3. Spawns a child session on that worktree
     - Child inherits: model config, MCPs, permission mode
     - Child gets PR context injected: diff, description, files, review prompt
  4. Gateway creates ThreadSessionMap: "preset-io/agor#42" → child session ID
  5. Assistant tracks: { pr: 42, childSession: <id>, worktree: <id>, status: "reviewing" }
```

### Phase 3: Child Agent Works

```
Child session starts on the PR worktree
  ↓
Child agent has access to:
  - Full repo checkout (the PR's branch)
  - MCP servers (GitHub MCP, repo-specific MCPs)
  - PR diff and metadata (injected by assistant)
  - The codebase itself (checked out at the PR branch)
  ↓
Child works — visible on Agor board in real-time
  ↓
Child produces output (review comments, suggestions, code changes)
```

### Phase 4: Results Flow Back

```
Child session produces results
  ↓
Results flow: child → gateway outbound hook → GitHubConnector
  ↓
GitHubConnector.sendMessage() posts comment on PR via GitHub API
  ↓
Optionally: posts inline review comments on specific files/lines
  ↓
Assistant is aware of the outcome (can log, learn, update memory)
```

### Phase 5: Follow-Up Prompts

```
User replies to Agor's comment (or posts new "@agor" comment on same PR)
  ↓
Next poll cycle detects new mention → gateway finds ThreadSessionMap → routes to child session
  ↓
New prompt sent to existing child session — full context preserved
  ↓
Child continues working with complete conversation history
  ↓
(If child session has ended, assistant can spawn a new one with context)
```

### Phase 6: Memory & Learning

```
After each PR interaction:
  ↓
Assistant updates its memory:
  - What was reviewed, what issues were found
  - Patterns in this repo (common mistakes, style preferences)
  - Which files are hot spots, which areas need attention
  ↓
Next PR review benefits from accumulated knowledge:
  - "This repo uses Zustand, not Redux — don't suggest Redux patterns"
  - "The team prefers explicit error handling over try/catch-all"
  - "Files in /api/v2/ follow a specific middleware pattern"
```

### PR Lifecycle Events

| GitHub Event | Who Handles | Action |
|-------------|-------------|--------|
| `@agor` comment on PR (new) | Assistant | Creates worktree + spawns child session |
| `@agor` comment on PR (existing) | Child session (via thread map) | Routes as follow-up prompt |
| PR updated (new commits) | Assistant | Notifies child: "PR updated, N new commits" |
| PR merged | Assistant | Archives child session, optionally cleans worktree |
| PR closed (not merged) | Assistant | Archives child session |
| PR reopened | Assistant | Reactivates or spawns new child session |

### Why the Assistant Model Matters

The assistant is what makes this **fundamentally different** from Claude Code Action:

1. **Memory** — the assistant learns the codebase across many PRs. Review #50 is smarter than review #1.
2. **Orchestration** — for complex PRs, the assistant can spawn multiple child agents (one for tests, one for security review, one for style).
3. **Continuity** — the assistant persists across PR lifecycles. It knows the repo's history, conventions, and team preferences.
4. **User configuration** — gateway channel affordances (user mapping, agentic config, MCPs) configure the assistant, which propagates settings to children.
5. **Observability** — the assistant and all its children are visible on the board. You can see the "GitHub handler" orchestrating work in real-time.

---

## 5. VPN / Private Network — Non-Issue

The polling architecture eliminates the VPN challenge entirely (see [Section 2](#2-the-agor-github-app) for details).

**TL;DR:** Agor reaches out to GitHub (outbound HTTPS), not the other way around. Works behind any VPN, firewall, or private network with zero configuration. No tunnels, no webhook URLs, no firewall rules, no VPN credentials as secrets.

---

## 6. Gateway Channel Configuration

### Global vs Type-Specific Fields

Gateway channels have two layers: **global fields** (materialized columns, same for all channel types) and **type-specific config** (JSON blob, encrypted at rest).

#### Global Fields (All Channel Types)

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Human label ("Preset GitHub", "eng-slack") |
| `channel_type` | enum | `'slack'` \| `'github'` \| ... |
| `target_worktree_id` | FK | Assistant's "home" worktree |
| `agor_user_id` | FK | Channel owner (fallback user for sessions) |
| `channel_key` | UUID | Auth secret for inbound webhook mode |
| `enabled` | boolean | Kill switch |
| `agentic_config` | JSON | Session creation template (see below) |

#### Agentic Config (Global, Session Template)

Already well-defined, applies to all channel types:

```typescript
interface GatewayAgenticConfig {
  agent: AgenticToolName;        // 'claude-code' | 'codex' | 'gemini' | ...
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  mcpServerIds?: string[];        // MCP servers attached to sessions
  // ... codex-specific fields
}
```

#### Cross-Platform Patterns in Type-Specific Config

Some config concepts appear in both Slack and GitHub with the same semantics:

| Concept | Slack Field | GitHub Field | Candidate for Promotion? |
|---------|------------|-------------|:---:|
| Platform credentials | `bot_token`, `app_token` | `installation_id`, `app_id`, `private_key` | No (fundamentally different) |
| Require @mention | `require_mention` | `require_mention` | Maybe (same semantics) |
| User → Agor mapping | `align_slack_users` | `align_github_users` | **Yes** → `align_users` |
| Scope filter | `allowed_channel_ids[]` | `watch_repos[]` | No (different units) |
| Thread reply behavior | `allow_thread_replies_without_mention` | `respond_to_review_comments` | No (different semantics) |

**`align_users` is the clearest candidate for promotion to global.** The mechanism differs per platform (Slack email lookup vs GitHub email lookup) but the intent is identical.

### GitHub-Specific Config (`config` Blob)

```typescript
interface GitHubChannelConfig {
  // ── Authentication (encrypted at rest) ──────────────────
  // Created via `agor github setup` (App Manifest flow)
  app_id: number;                  // GitHub App ID (from manifest flow)
  installation_id: number;         // Installation ID (discovered after install)
  private_key: string;             // PEM private key (encrypted, from manifest flow)

  // ── Event Ingestion ─────────────────────────────────────
  mode?: 'poll' | 'webhook';      // Default: 'poll'
  poll_interval_ms?: number;      // Default: 15000 (15s)
  webhook_secret?: string;        // Only for webhook mode (encrypted)

  // ── Scope ───────────────────────────────────────────────
  // One channel = one GitHub App installation (covers an org).
  // These filters narrow what the assistant watches within that installation.
  watch_repos?: string[];         // e.g. ['agor', 'superset'] — empty = all repos in installation
  watch_events?: ('pr_comment' | 'issue_comment' | 'pr_opened')[];
                                  // Default: ['pr_comment']

  // ── Trigger Behavior ───────────────────────────────────
  require_mention?: boolean;      // Require @agor mention (default: true)
  mention_keyword?: string;       // Default: 'agor' (matches @agor in comments)
  auto_review_on_pr_open?: boolean; // Auto-review new PRs without mention (default: false)
  respond_to_review_comments?: boolean; // Handle inline review threads (default: true)

  // ── User Alignment ─────────────────────────────────────
  align_github_users?: boolean;   // Map GitHub login → Agor user via email
}
```

### Scope: One Channel = One Installation

A GitHub App installation covers an org + selected repos. **One gateway channel maps to one installation:**

```
preset-io org
  └── GitHub App Installation (installation_id: 12345)
        ├── preset-io/agor         ┐
        ├── preset-io/superset     ├── One gateway channel
        └── preset-io/other-repo   ┘
                                        watch_repos: ['agor']  ← further filter
```

- Installation already scopes repos (user picks during install on GitHub)
- `watch_repos` further narrows within the installation (empty = all)
- Per-repo behavior customized via `.github/agor.yml` in each repo
- The assistant routes internally by `owner/repo` in thread IDs
- Avoids channel sprawl: 1 channel per org, not 1 per repo

### Side-by-Side: Slack vs GitHub Config

| Concern | Slack | GitHub |
|---------|-------|--------|
| **Credentials** | `bot_token`, `app_token` | `installation_id`, `app_id?`, `private_key?` |
| **Encrypted fields** | `bot_token`, `app_token`, `signing_secret` | `private_key`, `webhook_secret` |
| **Listening mechanism** | Socket Mode (WebSocket, outbound) | Poll loop (HTTP GET, outbound) |
| **Scope** | `allowed_channel_ids[]`, `enable_channels/groups/mpim` | `watch_repos[]`, `watch_events[]` |
| **Mention required?** | `require_mention` (default: true) | `require_mention` (default: true) |
| **Thread replies** | `allow_thread_replies_without_mention` | `respond_to_review_comments` |
| **Auto-trigger** | _(not yet)_ | `auto_review_on_pr_open` |
| **User alignment** | `align_slack_users` | `align_github_users` |
| **Markdown handling** | `slackify-markdown` conversion | Pass-through (GitHub is markdown-native) |

### Per-Repo Config (`.github/agor.yml`)

Optional — the assistant reads this via Contents API when processing events for a repo:

```yaml
# .github/agor.yml
auto_review: true              # Auto-review all PRs (overrides channel default)
review_scope:
  exclude_paths:
    - "*.lock"
    - "dist/**"
  exclude_authors:
    - "dependabot[bot]"
review_prompt: |
  Focus on security, correctness, and adherence to our coding standards.
  Check CLAUDE.md for project-specific conventions.
```

This follows the same pattern as Dependabot (`dependabot.yml`), Renovate (`renovate.json`), and CodeRabbit (`.coderabbit.yaml`). No GitHub platform support — just a convention the connector implements.

---

## 6b. GitHub Connector Implementation

### Thread ID Format

```
"preset-io/agor#42"           → PR thread
"preset-io/agor#42/review/1"  → Review thread within PR
"preset-io/agor/issues/10"    → Issue thread (future)
```

### Inbound: Polling (Default)

```typescript
async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
  // For each repo in watch_repos (or all repos in installation):
  this.pollInterval = setInterval(async () => {
    for (const repo of this.repos) {
      // GET /repos/:owner/:repo/issues/comments?since=<last_poll>
      // Header: If-None-Match: "<etag>"
      // Filter for @agor mentions
      // Deduplicate by comment ID
      // Emit InboundMessage for each new mention
    }
  }, this.config.poll_interval_ms ?? 15000);
}
```

### Outbound: Session → PR Comment

```typescript
async sendMessage(req: { threadId: string; text: string }): Promise<string> {
  const { owner, repo, prNumber } = parseThreadId(req.threadId);
  const octokit = await this.getInstallationOctokit();

  const { data } = await octokit.issues.createComment({
    owner, repo,
    issue_number: prNumber,
    body: req.text,  // Markdown native — no conversion needed
  });
  return String(data.id);
}
```

### Markdown Handling

Unlike Slack (which needs `slackify-markdown`), GitHub is markdown-native. `formatMessage()` is a pass-through with minor adjustments:
- Add collapsible `<details>` sections for long outputs
- Format code suggestions as GitHub suggestion blocks

### Type Extension

```typescript
// packages/core/src/types/gateway.ts
export type ChannelType = 'slack' | 'discord' | 'whatsapp' | 'telegram' | 'github';
```

### Registration

```typescript
// packages/core/src/gateway/connector-registry.ts
connectors.set('github', (config) => new GitHubConnector(config));
```

---

## 7. User Identity & Permissions

### GitHub User → Agor User Mapping

Follow the same pattern as Slack's `align_slack_users`:

```
GitHub comment by "maxdotio"
  ↓
GitHubConnector extracts commenter's GitHub email
  (via GitHub API: GET /users/maxdotio → email)
  ↓
Gateway service: usersRepo.findByEmail("max@preset.io")
  ↓
Match found → session created as Agor user "max"
  ↓
No match → fallback to channel owner (or reject with helpful message)
```

**Config flag:** `align_github_users: true`

### Permission Model

```
GitHub User → Agor User → Worktree RBAC → Session Permissions
```

- If RBAC is enabled, the mapped Agor user must have access to the target worktree
- If RBAC is disabled (default), any mapped user can create sessions
- Session inherits permission mode from channel's `agentic_config`

### GitHub App Permissions Required

| Permission | Access | Reason |
|-----------|--------|--------|
| Contents | Read & Write | Read code, push commits/suggestions |
| Pull Requests | Read & Write | Post comments, read PR metadata |
| Issues | Read & Write | Respond to issue comments |
| Metadata | Read | Repository info, user info |
| Webhooks | — | Automatic with GitHub App |

---

## 8. Agor's Role vs. Admin's Role

### What Agor Provides (Infrastructure)

Agor is **routing infrastructure**, not the intelligence layer. Its guarantees are simple:

1. **Detect** `@agor` mentions in PR/issue comments (via polling)
2. **Route** to a new session if none exists for that PR/issue, or to the existing session if one does
3. **Pass** the user's message with routing metadata (repo, PR/issue number, URL, commenter)
4. **Reply** by posting session output as PR/issue comments via GitHub API

The initial prompt for a new session looks like:

```
[GitHub] @johndoe mentioned you on preset-io/agor#42
https://github.com/preset-io/agor/pull/42#issuecomment-123456

can you check the latest rounds of edits
```

For follow-up `@agor` mentions in the same PR/issue, the message is routed to the existing session as a continuation prompt.

### What the Admin Configures (Intelligence)

Everything else is the **admin's responsibility** when setting up their Agor Assistant:

- **Instructions**: What to do when mentioned (review PRs, respond to issues, triage bugs, etc.)
- **Context gathering**: Whether to read all comments, fetch diffs, check CI status
- **Worktree management**: Whether to create worktrees for PR branches
- **Multi-agent orchestration**: Whether to spawn child agents for parallel review
- **Memory & learning**: Whether to accumulate repo expertise across PRs
- **Response formatting**: Whether to use inline review comments, suggestion blocks, etc.
- **MCP tools**: Which tools the assistant has access to (GitHub API, file system, etc.)

This follows Agor's [assistant model](https://agor.live/blog/agor-assistants) — admins configure persistent agents with tailored instructions, and those agents can leverage all of Agor's primitives (worktrees, sessions, MCP tools) as they see fit.

### Example: Admin-Configured GitHub Handler

An admin might set up an assistant with instructions like:

```
You are a GitHub PR reviewer for preset-io/agor.

When mentioned on a PR:
1. Read all comments and reviews on the PR
2. Fetch the PR diff using the GitHub API
3. Create a worktree for the PR branch
4. Review the code changes for bugs, style issues, and test coverage
5. Post your review as a PR comment with specific suggestions

When mentioned on an issue:
1. Read the issue description and all comments
2. Triage: is this a bug, feature request, or question?
3. Respond with next steps or delegate to a child agent
```

The key insight: **Agor provides the plumbing, the admin provides the intelligence.**

---

## 9. Implementation Phases

### Phase 1: GitHub Connector (Backend)

**Goal:** `@agor` mentions on PRs/issues flow into Agor sessions and replies go back.

1. Add `'github'` to `ChannelType` union ✅
2. Implement `GitHubConnector` with polling mode (outbound-only) ✅
3. Register connector in `connector-registry.ts` ✅
4. Poll for `@agor` mentions in PR/issue comments ✅
5. Outbound: post PR comments from session messages via GitHub API ✅
6. GitHub App authentication (installation tokens via `@octokit/auth-app`) ✅
7. Gateway routing with per-PR/issue session scoping ✅
8. Install `@octokit/rest` + `@octokit/auth-app` in `packages/core`

### Phase 2: Setup Flow (GUI-First)

**Goal:** "Connect GitHub" in the Agor UI with full setup wizard.

1. Daemon endpoints for App Manifest flow:
   - `GET /api/github/manifest` — serves auto-submit form
   - `GET /api/github/manifest/callback` — handles GitHub redirect, exchanges code for credentials
   - `GET /api/github/installations` — polls/lists installations for a stored app
2. UI: "Add GitHub Channel" in gateway channel creation modal
   - Step 1: Create app (manifest flow) or paste existing app credentials
   - Step 2: Install on org + installation discovery
   - Step 3: Configure channel (worktree, agentic settings, watch_repos, poll interval)
3. Extend existing gateway channel form with GitHub-specific config fields

### Phase 3: Advanced Triggers & Lifecycle (Future)

**Goal:** Proactive event handling beyond `@agor` mentions.

1. `pull_request.opened` → auto-route to assistant (configurable)
2. `pull_request.synchronize` → notify existing session of new commits
3. `pull_request.closed/merged` → archive session, optionally clean worktree
4. Configurable trigger scope (all PRs, labeled PRs, specific authors)

### Phase 4: Webhook Mode (Optional Upgrade)

**Goal:** Instant event delivery for instances with public endpoints.

1. Add webhook handler: `POST /webhooks/github/:channelKey`
2. Webhook signature verification (HMAC-SHA256)
3. Enable webhooks on the GitHub App and point to Agor's endpoint
4. Connector auto-switches from poll loop to webhook handler

---

## 10. Resolved Questions

### Product Decisions

1. **Board placement & zones** — ✅ Resolved
   - Channel config's `target_worktree_id` determines the board
   - The GitHub Helper assistant manages its own zones/board layout — no special auto-creation logic needed
   - Assistant can learn over time how to organize PR worktrees on the board

2. **App naming** — ✅ Resolved
   - Default name: **"Agor"** (simple, clean)
   - Only needs unique naming if there's a shared namespace conflict (unlikely for self-hosted)

3. **PR/Issue thread-session mapping** — ✅ Resolved
   - Thread-session routing is scoped **per-issue or per-PR**
   - Every `@agor` mention within the same PR/issue routes to the **same child session**
   - Agent reads all comments, reviews, and context each time it's prompted (full thread awareness)
   - This means follow-up `@agor` comments don't create new sessions — they continue the existing one

4. **Session lifecycle on PR close** — ✅ Resolved
   - Not a priority for MVP — skip for now
   - Nice-to-have: archive child session on PR close/merge
   - Worktree cleanup deferred to later phase

### Technical Decisions

5. **Polling efficiency at scale** — ✅ Resolved (see Appendix A)
   - ~1,200 req/hour for 5 repos at 15s interval (mostly 304s)
   - Scales to ~20-30 repos before rate limits matter
   - For larger installs: increase interval or filter with `watch_repos`

6. **GitHub App token management** — ✅ Resolved
   - Use `@octokit/auth-app` for automatic installation token refresh (1hr TTL)

7. **Rate limiting** — ✅ Resolved
   - 5,000 req/hour per installation, 304s don't count, ~96% headroom typical
   - Handle rate limit responses with backoff

8. **Diff size limits** — ✅ Resolved
   - Use `GET /repos/:owner/:repo/pulls/:number/files` for per-file patches
   - Truncate individual file patches at ~10K chars, skip binary files
   - Cap total context at ~100K chars
   - Always include full file list even when patches are truncated

9. **Private key storage** — ✅ Resolved
   - Use existing gateway channel encrypted config storage (same as Slack's `bot_token`)
   - Key rotation: user re-runs `agor github setup` to regenerate (no rotation UX for MVP)

---

## Appendix A: Polling Mechanics & Exactly-Once Processing

### Why Polling Is the Default

Each org's GitHub App is created with `hook_attributes.active: false` (webhooks disabled). Polling is the default because:

- **No public endpoint needed** — works behind any VPN/firewall
- **No webhook handler to build** for the MVP
- **Each org's app is independent** — no coordination between instances
- **Upgradeable** — enable webhooks later by updating app settings and adding a webhook URL

### Poll Loop Architecture

```
Daemon startup
  ↓
For each enabled GitHub gateway channel:
  ↓
Start poll loop (connector.startListening)
  ↓
Every poll_interval_ms (default: 15s):
  ↓
For each repo in watch_repos (or all repos in installation):
  │
  ├── GET /repos/:owner/:repo/issues/comments?since=<last_poll_at>
  │   Header: If-None-Match: "<etag>"
  │   │
  │   ├── 304 Not Modified → skip (free, no rate limit cost)
  │   └── 200 OK → process new comments
  │         │
  │         ├── Filter: contains @agor mention?
  │         ├── Dedup: already in processed_ids set?
  │         ├── YES to both → emit InboundMessage
  │         └── Update: last_poll_at, etag, add to processed_ids
  │
  ├── GET /repos/:owner/:repo/pulls?state=open&sort=updated&since=<last_poll_at>
  │   (for PR lifecycle events: new commits, closed, merged)
  │
  └── Save state to DB (last_poll_at, processed_ids snapshot)
```

### Exactly-Once State

```typescript
// Stored in DB per channel (survives daemon restart)
interface GitHubPollState {
  channel_id: string;
  repo: string;                    // "preset-io/agor"
  last_poll_at: string;            // ISO timestamp — used as `since` param
  last_etag: string | null;        // For conditional requests
  processed_comment_ids: number[]; // Ring buffer, last N IDs (e.g., 1000)
  updated_at: string;
}
```

**Restart recovery:** On daemon restart, the connector reads `last_poll_at` from DB and resumes polling from there. The `since` parameter catches any comments created during downtime. The `processed_comment_ids` set prevents double-processing of comments that were partially handled before the restart.

**Ring buffer for dedup:** Keep the last ~1000 comment IDs. Older IDs are evicted. This bounds memory usage while providing enough history to prevent duplicates across poll cycles and short restarts. Long outages (>1000 new comments) may cause re-processing — acceptable since the gateway service's ThreadSessionMap routing is idempotent for existing threads.

### Rate Limit Budget

For a typical setup (1 org, 5 repos, 15s poll interval):

```
Per hour: 5 repos × (60/15) polls/min × 60 min = 1,200 requests
  minus 304s (most polls): ~100-200 actual requests/hour
  Budget: 5,000 req/hour per installation
  Headroom: ~96% unused
```

Scales comfortably to ~20-30 repos before rate limits matter. For larger installations, increase `poll_interval_ms` or use `watch_repos` to filter.

---

## Appendix B: Installation Flow Details

### The Two-Step Flow

App creation and installation are separate steps in GitHub's model:

**Step 1: Create the App** (automated via `agor github setup`):
```
CLI starts local HTTP server → opens browser → user clicks "Create"
  → GitHub redirects to localhost with code
  → CLI exchanges code for credentials (app_id, PEM, webhook_secret)
  → CLI stores credentials in Agor config
```

**Step 2: Install the App on Org/Repos** (manual click on GitHub):
```
CLI opens: github.com/apps/YOUR-APP/installations/new
  → User selects org + repos → clicks "Install"
  → CLI discovers installation_id via GET /app/installations
  → Creates gateway channel + provisions assistant
```

Step 2 is unavoidable — GitHub has no API for programmatic installation. But the CLI automates everything around it (discovery, channel creation).

### Installation Discovery

After the user installs the app on GitHub, the CLI discovers the installation automatically:

```typescript
// Authenticate as the app (JWT)
const installations = await octokit.apps.listInstallations();

// Find the most recent installation
const latest = installations.data
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

// Show to user: "Found: preset-io (installed 2 min ago) — Connect?"
```

This works because the CLI holds the app's private key (from step 1) and can authenticate as the app to list its installations. No webhook callback needed.

### GitHub Enterprise Server

The manifest flow works on GHES — just point at the GHES instance instead of github.com:

```
POST https://GHES-HOSTNAME/settings/apps/new
POST https://GHES-HOSTNAME/api/v3/app-manifests/{code}/conversions
```

The `agor github setup` command could accept a `--github-url` flag for GHES instances.

---

## Appendix C: Comparison with Claude Code Action

| Dimension | Claude Code Action | Agor GitHub App |
|-----------|-------------------|------------------------|
| **Architecture** | Agent runs in GHA VM | Agent runs on Agor server |
| **Event delivery** | GHA workflow trigger | Polling (default) or webhooks |
| **Session persistence** | Ephemeral (dies with runner) | Persistent (lives on board) |
| **Post-promptable** | No (new run per mention) | Yes (same session, full context) |
| **Observable** | GHA logs only | Real-time on Agor canvas |
| **Multi-agent** | No | Yes (admin-configured assistant) |
| **MCP access** | Limited (GHA environment) | Full (all configured MCPs) |
| **Memory** | None (stateless) | Admin-configured via assistant |
| **Compute cost** | GitHub Actions minutes | Agor server resources |
| **Setup** | `/install-github-app` + GHA workflow | `agor github setup` (manifest flow) |
| **Network** | No VPN needed (runs on GHA) | No VPN needed (outbound polling) |
| **Requires GHA** | Yes | No |

## Appendix D: Gateway Service Reuse

The existing gateway service (`apps/agor-daemon/src/services/gateway.ts`) handles 90% of what's needed:

| Gateway Service Feature | Reusable for GitHub? |
|------------------------|---------------------|
| Thread → Session mapping | Yes, directly |
| Session creation with agentic config | Yes, directly |
| User identity alignment (email-based) | Yes, directly |
| Outbound message routing (hook) | Yes, directly |
| Encrypted credential storage | Yes, directly |
| MCP server attachment | Yes, directly |
| Custom context (gateway_source) | Yes, add PR metadata |
| Channel CRUD + management | Yes, directly |

**New code needed:**
- `GitHubConnector` class (~300 lines) — polling, mention detection, comment posting
- GitHub App authentication (`@octokit/auth-app` for automatic token management)
- `agor github setup` CLI command (App Manifest flow + installation discovery)
- GitHub-specific routing metadata in gateway service
- Optional webhook handler (upgrade path for instant delivery)
