# Board "Artifact" Primitive via Sandpack

**Status:** Implementation (v1)
**Date:** 2026-04-03
**Branch:** `board-app-primitive-sandpack`

---

## Overview

Agor boards can now host **Artifacts** — live, interactive web applications that render directly on the board canvas. Agents create artifacts via MCP tools, write code to the filesystem, and the artifact auto-refreshes on the board.

The runtime is powered by [Sandpack](https://sandpack.codesandbox.io/), CodeSandbox's open-source in-browser bundler. All code execution happens client-side in an iframe sandbox.

---

## Architecture

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Naming** | "Artifact" (not "app") | Modest, aligns with Claude Desktop artifacts |
| **Storage** | Filesystem-backed in worktree | Agents use normal file tools to edit code |
| **Board object** | Thin reference (`{ type: 'artifact', artifact_id }`) | Code stays on disk, not in board JSON |
| **DB table** | `artifacts` (metadata only) | Tracks build status, content hash, ownership |
| **Build checking** | Daemon-side via `new Function()` (v1) | Synchronous syntax validation; esbuild in v2 |
| **Console capture** | Browser → POST to daemon → ring buffer | Agent queries via `agor_artifacts_status` |
| **Runtime** | Sandpack 2 | Lightweight, React-native, battle-tested |

### Data Flow

```
Agent MCP                     Daemon                      Browser
  │                             │                           │
  ├─ agor_artifacts_create ────►│ scaffold filesystem       │
  │                             │ write sandpack.json        │
  │                             │ write files                │
  │                             │ create DB record           │
  │                             │ upsert board object        │
  │                             │─── WebSocket 'created' ──►│
  │                             │                           │ fetch payload
  │                             │◄── GET /payload ──────────│
  │                             │ read files from disk       │
  │                             │─── JSON response ────────►│
  │                             │                           │ render Sandpack
  │                             │                           │
  ├─ (edit files on disk) ─────►│                           │
  ├─ agor_artifacts_refresh ───►│ compute new hash          │
  │                             │─── WebSocket 'patched' ──►│
  │                             │                           │ refetch payload
  │                             │                           │
  │                             │◄── POST /console ────────│ forward console logs
  │                             │ ring buffer append         │
  │                             │                           │
  ├─ agor_artifacts_status ────►│ return status + logs      │
  │◄── { build, console } ─────│                           │
```

### Filesystem Layout

```
{worktree_path}/
  .agor/
    artifacts/
      {artifact_id}/
        sandpack.json      # Manifest: { template, dependencies, entry }
        App.js             # Source files (template-dependent)
        styles.css
        ...
```

The `sandpack.json` manifest maps directly to Sandpack React component props. Agents edit files using normal file tools — no special MCP tool needed for file editing.

---

## Sandpack

### Why Sandpack?

- In-browser bundler — no server needed, all execution happens in iframe
- First-class React integration via `@codesandbox/sandpack-react`
- NPM dependencies fetched from CDN on demand
- Templates: `react`, `react-ts`, `vanilla`, `vanilla-ts`, `vue`, `vue3`, `svelte`, `solid`, `angular`
- Mature: 6k+ GitHub stars, used by React docs, Docusaurus, etc.

### Key Insight

Sandpack has **zero persistence**. It's a pure React component that takes `files: Record<string, string>` as props and renders an iframe. No filesystem, no server, no serialization. We own the entire persistence layer.

### Console/Build Hooks

- `useSandpackConsole()` — captures console.log/warn/error from the iframe
- `listen()` — subscribe to all Sandpack events (build status, errors)
- `SandpackError` type for structured error reporting

---

## Implementation

### Backend

**Types (`packages/core/src/types/artifact.ts`):**
- `Artifact` — DB entity with metadata (build_status, content_hash, etc.)
- `ArtifactPayload` — What the frontend receives (files + template + deps)
- `ArtifactConsoleEntry` — Console log entries from the browser
- `ArtifactStatus` — Build status + console logs for agent queries

**Board type (`packages/core/src/types/board.ts`):**
```typescript
interface ArtifactBoardObject {
  type: 'artifact';
  x: number; y: number;
  width: number; height: number;
  artifact_id: string;  // Thin reference — no code inline
}
```

**DB schema:** `artifacts` table with FK to `worktrees` and `boards` (cascade delete).

**Service (`apps/agor-daemon/src/services/artifacts.ts`):**
- `createArtifact()` — Scaffolds directory, writes sandpack.json + files, creates DB record, upserts board object
- `getPayload()` — Reads filesystem, returns files + manifest for Sandpack
- `checkBuild()` — Basic syntax validation via `new Function()`
- `refresh()` — Recomputes content hash, triggers WebSocket broadcast
- `appendConsoleLogs()` — Ring buffer (100 entries max) for console capture
- `getStatus()` — Returns build status + console logs for agents
- `deleteArtifact()` — Removes filesystem + board object + DB record

**REST routes:**
- `GET /artifacts/:id/payload` — Serves artifact files for Sandpack rendering
- `GET /artifacts/:id/hash` — Lightweight hash check for cache invalidation
- `POST /artifacts/:id/console` — Receives console logs from browser

### MCP Tools

Six tools in the `artifacts` domain:
1. `agor_artifacts_create` — Create artifact with template, files, dependencies
2. `agor_artifacts_check_build` — Server-side syntax validation
3. `agor_artifacts_refresh` — Broadcast file changes to connected browsers
4. `agor_artifacts_status` — Get build status + console logs
5. `agor_artifacts_delete` — Remove artifact entirely
6. `agor_artifacts_list` — List artifacts, optionally by board

### Frontend

**ArtifactNode (`apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx`):**
- Fetches payload from daemon via REST (`/artifacts/:id/payload`)
- Renders `SandpackProvider` + `SandpackPreview` in an iframe
- `ConsoleReporter` child captures Sandpack console events, POSTs to daemon
- Polls `/artifacts/:id/hash` every 5s for content changes → triggers refetch
- `NodeResizer` for drag-resizing
- Pointer-event toggling for interact mode (iframe captures mouse otherwise)
- Loading/error states with retry

**Canvas wiring:**
- `useBoardObjects.ts` — `type === 'artifact'` branch creates `artifactNode`
- `SessionCanvas.tsx` — `artifactNode: ArtifactNode` registered in nodeTypes
- Z-index: 400 (above markdown 300, below worktrees 500)

---

## Agent Workflow

```
User: "Build me a dashboard showing session counts"

Agent:
1. agor_artifacts_create → {template: "react", files: {"/App.js": "..."}, dependencies: {"recharts": "^2"}}
   ← Returns { artifact, path: "/home/.agor/worktrees/main/.agor/artifacts/abc123/" }
2. Edit files at path using normal file tools
3. agor_artifacts_check_build → { status: "success", errors: [] }
4. agor_artifacts_refresh → Triggers browser reload
5. agor_artifacts_status → { console_logs: [...], build_status: "success" }
6. Iterate as needed
```

---

## Legacy: AppBoardObject (POC)

The initial POC used `AppBoardObject` with **inline files** stored directly in `board.objects`. This remains for backward compatibility but is superseded by the Artifact system:

| | AppBoardObject (POC) | ArtifactBoardObject (v1) |
|---|---|---|
| Storage | Inline in board JSON | Filesystem + DB |
| Agent editing | Via MCP tool only | Normal file tools |
| Size limit | Board JSON size | Disk space |
| Build checking | None | Daemon-side |
| Console capture | None | Browser → daemon ring buffer |

---

## Security

- Sandpack iframe runs on separate origin (`*.codesandbox.io`) — cannot access Agor DOM/cookies
- Dependencies loaded from npm CDN — same risk as any npm usage
- App code runs in user's browser with their network access
- Artifacts scoped to worktrees — inherits worktree RBAC

---

## Future Enhancements

- **esbuild build checking:** Replace `new Function()` with esbuild for import resolution + TypeScript validation
- **WebSocket-based reload:** Replace hash polling with real-time WebSocket events
- **Live collaboration:** Multiple users see same app state via WebSocket file sync
- **Version history:** Track file changes, allow rollback
- **Forking:** Duplicate an artifact to iterate on a variation
- **Full-stack apps:** Use Sandpack's Nodebox for Next.js/Vite SSR apps
- **Deploy pipeline:** One-click deploy to Vercel/Netlify
