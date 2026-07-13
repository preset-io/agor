# Docs feature navigation IA review

Date: 2026-06-16

## Problem

The guide sidebar previously put roughly fifteen feature pages under one flat **Features** heading. That made first-time readers parse implementation details, core product primitives, collaboration features, and technical integration surfaces as peers.

For external/prospect readers, the docs should first answer:

1. What is the unit of work?
2. Where do agent conversations live?
3. How does the team see and coordinate that work?
4. How do persistent teammates and shared context fit in?

## Current inventory

Before this review, the Features block included:

- Features Overview
- Branches
- Sessions & Trees
- Boards & Zones
- Teammates
- Knowledge
- Agor MCP Server
- Rich Chat UX
- In-Conversation Widgets
- Multiplayer & Social
- Environments
- Scheduler
- Cards (Beta)
- Artifacts
- API Proxies (CORS bypass)
- Message Gateway
- One-Time Launch Auth

## Recommended hierarchy

### 1. Feature Map

Keep one overview page as the map, but use grouped sections rather than a flat list. It should position Agor as the team command center, then route readers to core workflow first.

### 2. Core workflow

Top-level visibility:

- **Branches** — primary unit of work and anchor entity.
- **Sessions & Trees** — agent conversations and genealogy inside a branch.
- **Boards & Zones** — spatial canvas and prompt-triggering workflow regions.

These should remain prominent because they explain Agor's product model. If a reader only understands three pages, it should be these.

### 3. Agents & context

Top-level visibility, but after the primitives:

- **Teammates** — durable coworkers; long-lived identity and memory.
- **Knowledge** — shared context layer for humans and agents.
- **Agor MCP Server** — agent self-awareness and control surface.

Positioning: Teammates are the durable “who”; Knowledge is the workspace memory; MCP is the tool layer that lets sessions and teammates operate Agor.

### 4. Team workflow

Group collaboration and automation pages:

- **Multiplayer & Social**
- **Environments**
- **Scheduler**
- **Message Gateway**

Positioning: these make the branch/session/board model useful across teammates, time, and external communication channels.

### 5. Product experience & extensions

Group UI details and emerging primitives:

- **Rich Chat UX**
- **In-Conversation Widgets**
- **Cards (Beta)**
- **Artifacts**

Positioning: useful differentiators, but not the first concept stack a new prospect needs.

### 6. Technical reference

Move implementation or integration plumbing out of Features:

- **API Proxies (CORS bypass)**
- **One-Time Launch Auth**

Keep URLs stable, but treat these as reference pages rather than prospect-facing feature pillars.

## Migration path beyond nav-only grouping

This review intentionally preserves existing URLs. If we later want a deeper IA cleanup, do it in phases:

1. **Add category landing pages without moving old URLs.** For example `/guide/core-workflow`, `/guide/agents-and-context`, `/guide/team-workflow`, and `/guide/extensions`.
2. **Bundle thin or highly technical pages into broader pages.** Candidate bundles:
   - `rich-chat-ux` + `in-conversation-widgets` → “Conversation Experience”.
   - `artifacts` + `api-proxies` → “Artifacts” with API proxy details as a subsection.
   - `scheduler` + teammate heartbeat material → cross-link or merge into an “Automation” story.
   - `message-gateway` + launch auth → “External Channels & Launch” if launch handoff becomes user-facing.
3. **Only move/rename routes with redirects.** Existing URLs likely appear in screenshots, changelogs, and external links; avoid breaking them unless Next redirects are added.
4. **Revisit sidebar after category pages exist.** At that point, the sidebar can expose 4–6 category pages by default and tuck leaf pages under folder routes.

## Recommended final sidebar shape

Near term, keep the stock Nextra sidebar layout and avoid adding custom spacing or non-route grouping UI. Order the feature pages in conceptual clusters, with the grouping explained on the Feature Map page instead of adding many sidebar separators:

- Feature Map
- Branches
- Sessions & Trees
- Boards & Zones
- Teammates
- Knowledge
- Agor MCP Server
- Multiplayer & Social
- Environments
- Scheduler
- Message Gateway
- Rich Chat UX
- In-Conversation Widgets
- Cards (Beta)
- Artifacts
- Reference
  - Architecture
  - TypeScript Client
  - SDK Comparison
  - API Proxies
  - One-Time Launch Auth

Longer term, consider category landing pages so the first visible list is the category list, not every leaf page. That would reduce visible feature items without relying on extra separator spacing in the doctree.
