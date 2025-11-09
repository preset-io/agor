# Launch Prep - v0.4.0

**Target: Friday publish**
**Strategy: 2-day polish sprint (Wed/Thu), launch Friday**

---

## Testing Flows

### Day 1: Core Functionality

**Cold Start (Fresh Machine)**

```bash
npm install -g agor-live
agor init
agor daemon start
agor open
```

- [ ] Install completes without errors
- [ ] ~/.agor/ structure created correctly
- [ ] Daemon starts on first try
- [ ] Browser opens to UI
- [ ] Onboarding modal appears with real counts
- [ ] Anonymous auth works immediately

**Session Lifecycle**

- [ ] Create Claude session → send prompt → get streaming response
- [ ] Create Codex session → same flow
- [ ] Create Gemini session → same flow
- [ ] Fork session → genealogy link appears
- [ ] Restart daemon → sessions persist
- [ ] Delete session → removed from board and DB

**Board Interactions**

- [ ] Drag session around canvas (smooth, no lag)
- [ ] Create zone → configure trigger
- [ ] Drop session on zone → trigger fires with template
- [ ] Zoom in/out → stable rendering
- [ ] Delete zone → no orphaned triggers

**Worktrees & Environments**

- [ ] Create worktree from session
- [ ] Configure env (start: `npm run dev`, port: 3000)
- [ ] Start env → process spawns
- [ ] Terminal modal → connects to worktree shell
- [ ] Stop env → process terminates cleanly
- [ ] Port conflicts → handled gracefully

### Day 2: Polish & Edge Cases

**Multiplayer Edge Cases**

- [ ] Two browsers → cursor positions sync
- [ ] Move session in window A → appears in window B instantly
- [ ] Create zone in A → visible in B without refresh
- [ ] Daemon restart → both clients reconnect

**MCP Integration**

- [ ] Add MCP server in settings
- [ ] Session uses MCP tool (file read/write)
- [ ] Multiple sessions share same MCP config
- [ ] MCP endpoint logs show activity

**Failure Modes**

- [ ] Daemon offline → UI shows "Reconnecting..." banner
- [ ] Kill daemon mid-session → no data loss on restart
- [ ] Network drops → auto-reconnects when back
- [ ] Invalid worktree path → shows actionable error (not stack trace)
- [ ] Port 3030 in use → suggests alternative or shows clear conflict message

**UI Polish Sweep**

- [ ] All modals close with ESC key
- [ ] Loading spinners during async ops
- [ ] Empty states have helpful CTAs ("Create your first session")
- [ ] Hover states on all interactive elements
- [ ] No theme leaks (everything dark)
- [ ] Responsive: test on laptop (1440px) and wide monitor (2560px)

**Documentation Verification**

- [ ] README on GitHub: hero image loads, Mermaid renders
- [ ] All links valid (no 404s)
- [ ] Docs site (agor.live) loads
- [ ] Swagger at localhost:3030/docs works
- [ ] Codespaces quickstart link functional

**Performance Check**

- [ ] Daemon memory usage after 1 hour: reasonable (<500MB)
- [ ] UI doesn't leak memory (check DevTools heap)
- [ ] No console errors in browser
- [ ] Build produces no warnings

---

## Social Media Post

**Platform: Twitter/X, Reddit (r/programming, r/MachineLearning), Hacker News**

---

**Launching Agor v0.4.0 — Multiplayer Canvas for Orchestrating AI Agents**

I've been building a tool to manage Claude Code, Codex, and Gemini sessions on a spatial board. It's like Figma meets RTS for AI coding.

**What it does:**

- Run multiple AI agents in parallel, each in isolated git worktrees
- Drag sessions around a canvas, organize by project phase
- Define zones that trigger prompts when you drop sessions in them (kanban-style workflows)
- Real-time multiplayer: see teammates' sessions, cursors, threaded comments
- Unified MCP config: set up tools once, use across all agents

**Why I built this:**
AI coding sessions are ephemeral — conversations disappear, context gets lost, switching between agents means starting from scratch. I wanted persistent, spatial organization with the ability to fork sessions, hand work off between models, and collaborate with teammates like we're playing StarCraft but for code.

**Tech stack:**
FeathersJS (REST + WebSocket), LibSQL, React Flow, Ant Design. Local-first daemon, no cloud lock-in.

**Try it:**

```bash
npm install -g agor-live
agor init && agor daemon start && agor open
```

GitHub: github.com/preset-io/agor
Docs: agor.live
License: BSL 1.1 (free for non-commercial, converts to Apache 2.0 after 4 years)

Built in public over the last few months. Feedback welcome — especially from teams already juggling multiple AI tools.

---

## Friday: Launch Day

**Pre-Publish Checklist**

- [ ] Bump version to 0.4.0 in all package.json files
- [ ] Write CHANGELOG.md entry (highlight: API docs, Swagger, docs site overhaul)
- [ ] `npm publish --dry-run` on agor-live → verify contents
- [ ] Test Codespaces quickstart one more time
- [ ] Verify GitHub release assets (GIFs, screenshots) uploaded

**Publish Sequence**

1. `npm publish` for agor-live
2. Create GitHub release (tag v0.4.0) with changelog notes
3. Post announcement: Twitter → Reddit → HN (in that order, ~30 min apart)
4. Update docs site if any last-minute fixes

**Post-Launch**

- Monitor npm install count
- Watch GitHub issues for bug reports
- Respond to feedback within 24h
- Keep daemon running locally to dogfood

---

## Notes

- **Version decision:** Staying at 0.4.0 (not 1.0 yet). Still missing session forking UI, automated reports, context system. Those can be 1.0.
- **Target audience:** Indie devs, small eng teams, AI researchers who juggle Claude/Codex/Gemini
- **Key differentiator:** Multiplayer + spatial + git worktrees. No other tool treats agent sessions as collaborative, persistent objects.
- **Risk areas:** Fresh install UX (must be flawless), error messages (must be human-readable), daemon auto-restart (if it fails, users are stuck)

---

**Last updated:** 2025-10-28 (pre-launch week)
