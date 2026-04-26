<img src=".github/logo_circle.png" alt="Agor Logo" width="160" />

# Agor

**Think Figma, but for AI coding assistants.** Orchestrate Claude Code, Codex, and Gemini sessions on a multiplayer canvas. Manage git worktrees, track AI conversations, and visualize your team's agentic work in real-time.

> **TL;DR:** Agor is a multiplayer spatial canvas where you coordinate multiple AI coding assistants on parallel tasks, with GitHub-linked worktrees, automated workflow zones, and isolated test environments—all running simultaneously.

**📖 [Read the full documentation at agor.live →](https://agor.live/)**

---

## See It In Action

<div align="center">
  <table>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/Area.gif" alt="Spatial 2D Canvas"/>
        <p align="center"><em style="opacity: 0.5;">Spatial canvas with worktrees and zones</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/Convo.gif" alt="AI Conversation in Action"/>
        <p align="center"><em style="opacity: 0.5;">Rich web UI for AI conversations</em></p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/Settings.gif" alt="Settings and Configuration"/>
        <p align="center"><em style="opacity: 0.5;">MCP servers and worktree management</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/Social.gif" alt="Real-time Multiplayer"/>
        <p align="center"><em style="opacity: 0.5;">Live collaboration with cursors and comments</em></p>
      </td>
    </tr>
  </table>
</div>

**[→ Watch unscripted demo on YouTube](https://www.youtube.com/watch?v=3in0qh7ZH0g)** (13 minutes)

---

<div align="center">
  <h3>✨ Pledge ✨</h3>
  <p><strong>⭐️ I pledge to fix a GitHub issue for every star Agor gets :)</strong></p>
</div>

---

## Quick Start

Requires **Node.js ≥ 22.12** ([install](https://nodejs.org)).

```bash
npm install -g agor-live
agor init           # creates ~/.agor/ and database
agor daemon start   # runs in the background
agor open           # opens the UI
```

That's it. Visit [agor.live/guide/getting-started](https://agor.live/guide/getting-started) to add a repo and create your first session — the onboarding wizard takes it from there.

For Docker, source builds, Postgres, and team setups, see [Extended Installation](https://agor.live/guide/extended-install).

---

## What is Agor?

Agor is built on three foundational concepts:

- **[Worktrees](https://agor.live/guide/worktrees)** — the unit of work. A git worktree pinned to a board, with its own branch, isolated environment, and conversations.
- **[Sessions & Trees](https://agor.live/guide/sessions)** — agent conversations with genealogy. Fork to explore alternatives, spawn subsessions for focused subtasks.
- **[Boards & Zones](https://agor.live/guide/boards)** — a Figma-style 2D canvas of worktrees. Drop a worktree into a zone to trigger a templated prompt.

Everything else builds on these. **[Read the Features Overview →](https://agor.live/guide/features-overview)**

---

## Features

- **[Assistants](https://agor.live/guide/assistants)** — long-lived AI companions with file-based memory and skills, OpenClaw-style.
- **[Agor MCP Server](https://agor.live/guide/internal-mcp)** — anything a user can do in Agor, an agent can do too. Sessions are auto-issued an MCP token.
- **[Rich Chat UX](https://agor.live/guide/rich-chat-ux)** — per-prompt token + dollar accounting, model/effort selectors, structured tool blocks, completion chimes.
- **[Multiplayer & Social](https://agor.live/guide/multiplayer-social)** — live cursors, facepiles, spatial comments, shared multiplayer terminal.
- **[Environments](https://agor.live/guide/environment-configuration)** — one-click dev servers per worktree with auto-managed unique ports.
- **[Scheduler](https://agor.live/guide/scheduler)** — cron-style triggers for templated prompts. Powers assistant heartbeats and automated audits.
- **[Cards](https://agor.live/guide/cards)** (Beta) — generic workflow entities for non-code workflows.
- **[Artifacts](https://agor.live/guide/artifacts)** — live, interactive applications rendered on the board via Sandpack.
- **[Message Gateway](https://agor.live/guide/message-gateway)** — Slack and GitHub as portals to Agor sessions.

---

## Screenshots

<div align="center">
  <img src="https://github.com/preset-io/agor/releases/download/v0.7.9/hero.png" alt="Agor Board" style="width: 100%; border-radius: 8px; margin-bottom: 24px;" />
  <p style="opacity: 0.5;"><em>Multiplayer spatial canvas with zones, worktrees, and real-time collaboration</em></p>
</div>

<div align="center">
  <table>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/conversation_full_page.png" alt="Conversation View"/>
        <p align="center"><em style="opacity: 0.5;">Task-centric conversation UI</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/settings_modal.png" alt="Settings Modal"/>
        <p align="center"><em style="opacity: 0.5;">MCP server and worktree management</em></p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/zone_trigger_modal.png" alt="Zone Trigger Modal"/>
        <p align="center"><em style="opacity: 0.5;">Zone trigger modal on session drop</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/zone_trigger_config.png" alt="Zone Configuration"/>
        <p align="center"><em style="opacity: 0.5;">Zone trigger configuration</em></p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/env_configuration.png" alt="Environment Configuration"/>
        <p align="center"><em style="opacity: 0.5;">Worktree environment setup</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/create_session_modal.png" alt="Create Session Modal"/>
        <p align="center"><em style="opacity: 0.5;">Session creation with agent selection</em></p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/baked_in_terminal.png" alt="Built-in Terminal"/>
        <p align="center"><em style="opacity: 0.5;">Built-in terminal with worktree context</em></p>
      </td>
      <td width="50%">
        <img src="https://github.com/preset-io/agor/releases/download/v0.3.15/onboarding.png" alt="Onboarding Experience"/>
        <p align="center"><em style="opacity: 0.5;">Welcome screen showing team status</em></p>
      </td>
    </tr>
  </table>
</div>

---

## Architecture

```mermaid
graph TB
    subgraph Clients
        CLI["CLI (oclif)"]
        UI["Web UI (React)"]
    end

    Client["Feathers Client<br/>REST + WebSocket"]

    subgraph "Agor Daemon"
        Feathers["FeathersJS Server"]
        MCP["MCP HTTP Endpoint<br/>/mcp?sessionToken=..."]
        Services["Services<br/>Sessions, Tasks, Messages<br/>Boards, Worktrees, Repos"]
        AgentSDKs["Agent SDKs<br/>Claude, Codex, Gemini"]
        ORM["Drizzle ORM"]
    end

    subgraph Storage
        DB[("LibSQL Database<br/>~/.agor/agor.db")]
        Git["Git Worktrees<br/>~/.agor/worktrees/"]
        Config["Config<br/>~/.agor/config.yaml"]
    end

    CLI --> Client
    UI --> Client

    Client <-->|REST + WebSocket| Feathers

    Feathers --> Services
    Feathers --> MCP
    MCP --> Services
    Services --> ORM
    Services --> AgentSDKs
    AgentSDKs -.->|JSON-RPC 2.0| MCP

    ORM --> DB
    Services --> Git
    Services --> Config
```

**[Full Architecture Guide →](https://agor.live/guide/architecture)**

---

## Development

**[Development Guide →](https://agor.live/guide/development)**

Quickest path — run Agor from source via Docker:

```bash
git clone https://github.com/preset-io/agor.git
cd agor
docker compose up
```

The repo's `.agor.yml` defines variants (sqlite / postgres / full / docs) so you can spin up the exact dev setup you need. The dev guide also covers running Agor *inside* Agor for dogfooding, plus custom builds via `packages/agor-live/build.sh`.

---

## Roadmap

**[View roadmap on GitHub →](https://github.com/preset-io/agor/issues?q=is%3Aissue+state%3Aopen+label%3Aroadmap)**

Highlights:

- **Match CLI-Native Features** — SDKs are evolving rapidly and exposing more functionality. Push integrations deeper to match all key features available in the underlying CLIs
- **Bring Your Own IDE** — Connect VSCode, Cursor, or any IDE directly to Agor-managed worktrees via SSH/Remote
- **Unix User Integration** — Enable true multi-tenancy with per-user Unix isolation for secure collaboration. [Read the exploration →](https://github.com/preset-io/agor/blob/main/context/explorations/unix-user-integration.md)

---

## Community

- **[Discord](https://discord.gg/Qh4TrFQZpd)** - Join our Discord community for support and discussion
- **[GitHub Discussions](https://github.com/preset-io/agor/discussions)** - Ask questions, share ideas
- **[GitHub Issues](https://github.com/preset-io/agor/issues)** - Report bugs, request features

---

## About

**Heavily prompted by [@mistercrunch](https://github.com/mistercrunch)** ([Preset](https://preset.io), [Apache Superset](https://github.com/apache/superset), [Apache Airflow](https://github.com/apache/airflow)), built by an army of Claudes.

Read the story: [Making of Agor →](https://agor.live/blog/making-of-agor)
