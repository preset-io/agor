# Multiplayer Collaboration (Future Features)

**Status:** Exploration / Planning
**Related:** [../concepts/auth.md](../concepts/auth.md), [social-features.md](social-features.md)

**Note:** Basic multi-user collaboration is already working! See [../concepts/auth.md](../concepts/auth.md) for implemented features (user auth, real-time position sync, etc.).

This document explores **future** multiplayer features not yet implemented.

---

## What's Already Working ✅

See [../concepts/auth.md](../concepts/auth.md#real-time-collaboration-features) for details:

- User authentication (email/password + JWT)
- Multi-user boards with real-time position sync
- User profiles with emoji avatars
- WebSocket broadcasting for all CRUD operations
- User attribution (created_by tracking)

---

## Future Features (Phase 3+)

### Presence & Awareness (Phase 3a)

See [social-features.md](social-features.md) for detailed design:

- Facepile (who's active on board)
- Cursor swarm (real-time cursor positions)
- Presence indicators (who's viewing what)
- Typing indicators (who's prompting)

### Collaborative Session Access (Phase 3b)

**Permissions Model:**

- Board owner can invite collaborators
- Collaborators can view all sessions on board
- Collaborators can prompt any session (unless locked)
- Session locking (optional): Prevent concurrent prompts

**Conflict Resolution:**

- Optimistic UI updates (local changes apply immediately)
- Last-write-wins for simple fields (currently used)
- Operational Transformation (OT) for concurrent edits (future)
- Session lock prevents multiple agents running simultaneously

### Advanced Cursor Features (Phase 3b)

**Visual Indicators:**

- Cursors with username labels (like Figma)
- Session cards highlight when user is viewing
- Prompt input shows "User is typing..." indicator
- Mini avatars on active sessions

**Cursor Sync:**

- Throttle cursor movements (send every 50-100ms)
- Interpolate between positions for smoothness
- Hide cursor after 5s of inactivity
- Different cursor styles (pointer, grab, text)

### Viewport Sync (Phase 3c)

**Board Layout Sync:**

- Zoom level and pan position sync (optional: sync viewport)
- "Follow user" mode to match their viewport
- Auto-layout button to organize for everyone

### Activity Feed (Phase 3d)

**Features:**

- "User created Session X"
- "User forked Session Y"
- "User completed Task Z"
- Timeline view of all board activity
- Filter by user, action type, date range

### Comments & Annotations (Phase 3e)

**Features:**

- Comment threads on sessions
- @ mentions for notifications
- Resolve/unresolve threads
- Attach comments to specific tasks/messages

---

## Team Workflows (Future)

**Pair Programming:**

- Both users on same board
- User A prompts Session 1 (backend work)
- User B prompts Session 2 (frontend work)
- Both see each other's progress in real-time
- Cursor shows where teammate is working

**Code Review:**

- Reviewer joins board via link
- Sees session tree, clicks through tasks
- Leaves comments on specific sessions
- Author gets notified, addresses feedback

**Onboarding:**

- New team member joins board
- Browses historical sessions to understand decisions
- Sees what senior dev is working on (live cursor)
- Learns patterns by observing

---

## Open Questions

1. **Billing Model**: Who pays for API usage? Per-user? Per-board? Shared team credits?
2. **Offline Support**: What happens if cloud goes down? Local fallback mode?
3. **Version Control**: Should boards/sessions be git-like (branches, merges)? Or simpler?
4. **Agent Quotas**: Limit concurrent agents per team to prevent runaway costs?
5. **Session Replay**: Record all actions for playback (like session replay tools)?
6. **Cloud vs Local**: Keep dual mode or force cloud for multiplayer?

---

## Next Steps

See [social-features.md](social-features.md) for detailed implementation plan of Phase 3a features (facepile, cursor swarm, presence).

See [multiplayer-auth.md](multiplayer-auth.md) for enterprise features (OAuth, organizations, RBAC).

---

## References

- **Multiplayer Patterns**: [Yjs CRDT library](https://github.com/yjs/yjs)
- **Presence Examples**: [Liveblocks](https://liveblocks.io/), [PartyKit](https://partykit.io/)
- **Cursor Sync**: [Perfect Cursors](https://github.com/steveruizok/perfect-cursors)
- **WebSocket Scaling**: [Socket.io with Redis](https://socket.io/docs/v4/redis-adapter/)
