# Social Collaboration Features (Phase 3a)

**Status:** Future Work / Planning
**Related:** [../concepts/auth.md](../concepts/auth.md), [multiplayer.md](multiplayer.md)

## Overview

Now that multi-user authentication and real-time board sync are working, the next phase is adding **social awareness features** to make collaboration feel fluid and intuitive—like Figma/Miro but for AI agent orchestration.

**Goal:** Let users see what their teammates are doing in real-time without getting in each other's way.

---

## What's Already Working ✅

**Phase 2 Complete:**

- ✅ User authentication (email/password + JWT)
- ✅ Multi-user boards with real-time position sync
- ✅ User profiles with emoji avatars
- ✅ WebSocket broadcasting for all CRUD operations
- ✅ Debounced position updates with conflict resolution

**What's Missing:** Visual indicators of who's online, where they're looking, and what they're doing.

---

## Planned Features (Phase 3a)

### 1. Facepile (Who's Active)

**Priority:** High (foundational for other features)

**What It Is:**
A compact row of user avatars showing who's currently viewing the board.

**Design:**

```
┌─ Board Header ────────────────────────────────┐
│ 📊 Main Board                                  │
│                                                │
│ 👤 🦄 🐶 +3  ← Facepile (top-right corner)   │
└────────────────────────────────────────────────┘
```

**UI Library:** Use Ant Design's `Avatar.Group` component for automatic stacking, overlap, and "+N" overflow indicator.

**Implementation:**

```typescript
// Presence tracking (new data model)
interface BoardPresence {
  board_id: BoardID;
  user_id: UserID;
  last_seen: Date;
  cursor_position?: { x: number; y: number };
  viewing_session_id?: SessionID;
}

// WebSocket events
socket.emit('board:join', { board_id });
socket.emit('board:leave', { board_id });
socket.on('presence:updated', (presence: BoardPresence[]) => {
  // Update facepile UI
});
```

**Storage:** In-memory (Redis or daemon state, not persisted to DB)

**Lifecycle:**

1. User navigates to board → `socket.emit('board:join')`
2. Daemon tracks active connections per board
3. Heartbeat every 5s to keep connection alive
4. User navigates away or closes tab → `socket.emit('board:leave')`
5. Daemon broadcasts updated presence list to all board members

**UI Location:** Top-right corner of SessionCanvas, always visible

**Interactions:**

- Hover over avatar → Show tooltip with name
- Click avatar → Jump to their viewport (optional, Phase 3b)
- "+3" indicator → Click to expand full list

---

### 2. Cursor Swarm (Real-time Cursor Positions)

**Priority:** Medium (cool but not critical)

**What It Is:**
See other users' cursors moving on the canvas in real-time, with their name/emoji attached.

**Design:**

```
   👤 Max              🦄 Sarah
    ↓                   ↓
  ┌─────┐            ┌─────┐
  │     │            │     │
  └─────┘            └─────┘
  Session 1          Session 2
```

**Implementation:**

**Option A: Direct WebSocket Broadcasting (Simple)**

```typescript
// Client sends cursor position on mousemove
const handleMouseMove = throttle((e: MouseEvent) => {
  socket.emit('cursor:move', {
    board_id: currentBoardId,
    x: e.clientX,
    y: e.clientY,
  });
}, 50); // Throttle to 20 updates/sec

// Server broadcasts to other clients
socket.on('cursor:move', data => {
  // Broadcast to all clients on same board EXCEPT sender
  socket.to(`board:${data.board_id}`).emit('cursor:update', {
    user_id: socket.user.user_id,
    user_name: socket.user.name,
    user_emoji: socket.user.emoji,
    ...data,
  });
});

// Client renders remote cursors
socket.on('cursor:update', cursor => {
  updateCursorOverlay(cursor);
});
```

**Option B: Perfect Cursors Library (Smooth)**

Use [perfect-cursors](https://github.com/steveruizok/perfect-cursors) for smooth interpolation between cursor checkpoints:

```typescript
import { usePerfectCursor } from 'perfect-cursors';

// Interpolate between received positions for smooth movement
const point = usePerfectCursor(remoteCursor.position);
```

**Performance Considerations:**

- Throttle cursor events to 20 updates/sec (50ms intervals)
- Only send cursor position when inside canvas area
- Hide cursor after 3s of inactivity
- Use CSS transforms for cursor rendering (GPU-accelerated)

**UI Components:**

```tsx
// New component: CursorOverlay
interface RemoteCursor {
  user_id: string;
  user_name: string;
  user_emoji: string;
  x: number;
  y: number;
  last_updated: Date;
}

<CursorOverlay cursors={remoteCursors} />;
```

**Cursor Styling:**

- Render as SVG pointer with user emoji/name label
- Color from user profile (or auto-assigned)
- Fade out after 3s of no movement
- Z-index above canvas but below modals

---

### 3. Presence Indicators (Who's Viewing What)

**Priority:** Low (nice-to-have)

**What It Is:**
Show which session cards other users are currently viewing (have the drawer open for).

**Design:**

```
┌─────────────────┐
│ Session 1       │  ← Mini avatar badge (👤) in corner
│ "Add auth"      │
│ ✓ 3 tasks       │
└─────────────────┘
    👤 ← User is viewing this session
```

**Implementation:**

```typescript
// Track which session user has open
socket.emit('viewing:session', {
  board_id: currentBoardId,
  session_id: openSessionId,
});

// Broadcast to others
socket.on('viewing:updated', data => {
  // Show mini avatar on session card
  setViewingUsers(data.session_id, data.users);
});
```

**UI:**

- Small avatar badge in top-right corner of session card
- Multiple avatars stack horizontally
- Tooltip on hover: "Max, Sarah are viewing this"

---

### 4. Typing Indicators (Who's Prompting)

**Priority:** Low (nice-to-have)

**What It Is:**
Show when someone is typing a prompt into a session's prompt input.

**Design:**

```
┌─ Session Drawer ─────────────────────┐
│ Session 1: "Add authentication"      │
│                                       │
│ [Prompt input here...]                │
│ 👤 Max is typing...  ← Indicator     │
└───────────────────────────────────────┘
```

**Implementation:**

```typescript
// Client emits typing start/stop
const handlePromptInputChange = debounce(() => {
  socket.emit('typing:start', { session_id });

  // Auto-stop after 2s of no typing
  setTimeout(() => {
    socket.emit('typing:stop', { session_id });
  }, 2000);
}, 300);

// Server broadcasts typing state
socket.on('typing:updated', data => {
  // Show "User is typing..." below prompt input
  setTypingUsers(data.session_id, data.users);
});
```

**UI:**

- Small text below prompt input: "👤 Max is typing..."
- Multiple users: "👤 Max, 🦄 Sarah are typing..."
- Animated dots: "typing..."

---

## Technical Architecture

### Backend (Daemon)

**New Service: Presence Management**

```typescript
// apps/agor-daemon/src/services/presence.ts

interface PresenceState {
  user_id: UserID;
  board_id: BoardID;
  cursor_position?: { x: number; y: number };
  viewing_session_id?: SessionID;
  typing_session_id?: SessionID;
  last_seen: Date;
}

class PresenceManager {
  private presence: Map<SocketID, PresenceState>;

  join(socket: Socket, board_id: BoardID) {
    this.presence.set(socket.id, {
      user_id: socket.user.user_id,
      board_id,
      last_seen: new Date(),
    });

    this.broadcastPresence(board_id);
  }

  updateCursor(socket: Socket, position: { x: number; y: number }) {
    const state = this.presence.get(socket.id);
    if (state) {
      state.cursor_position = position;
      state.last_seen = new Date();

      // Broadcast to other users on same board
      socket.to(`board:${state.board_id}`).emit('cursor:update', {
        user_id: state.user_id,
        ...position,
      });
    }
  }

  leave(socket: Socket) {
    const state = this.presence.get(socket.id);
    if (state) {
      this.presence.delete(socket.id);
      this.broadcastPresence(state.board_id);
    }
  }

  broadcastPresence(board_id: BoardID) {
    const users = Array.from(this.presence.values()).filter(p => p.board_id === board_id);

    app.io.to(`board:${board_id}`).emit('presence:updated', users);
  }
}
```

**Socket.io Room Management:**

```typescript
// apps/agor-daemon/src/index.ts

const presenceManager = new PresenceManager();

app.io.on('connection', socket => {
  socket.on('board:join', data => {
    socket.join(`board:${data.board_id}`);
    presenceManager.join(socket, data.board_id);
  });

  socket.on('board:leave', data => {
    socket.leave(`board:${data.board_id}`);
    presenceManager.leave(socket);
  });

  socket.on('cursor:move', data => {
    presenceManager.updateCursor(socket, data);
  });

  socket.on('disconnect', () => {
    presenceManager.leave(socket);
  });
});
```

**Storage:** In-memory only (no DB persistence needed)

**Heartbeat:** Ping every 5s to detect disconnections

---

### Frontend (UI)

**New Hooks:**

```typescript
// apps/agor-ui/src/hooks/usePresence.ts

export function usePresence(boardId: BoardID) {
  const [activeUsers, setActiveUsers] = useState<User[]>([]);
  const socket = useAgorClient();

  useEffect(() => {
    socket.emit('board:join', { board_id: boardId });

    socket.on('presence:updated', users => {
      setActiveUsers(users);
    });

    return () => {
      socket.emit('board:leave', { board_id: boardId });
    };
  }, [boardId]);

  return { activeUsers };
}

// apps/agor-ui/src/hooks/useCursorBroadcast.ts

export function useCursorBroadcast(boardId: BoardID) {
  const socket = useAgorClient();
  const throttledEmit = useThrottle((position: { x: number; y: number }) => {
    socket.emit('cursor:move', { board_id: boardId, ...position });
  }, 50); // 20 updates/sec

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      throttledEmit({ x: e.clientX, y: e.clientY });
    },
    [throttledEmit]
  );

  return { handleMouseMove };
}

// apps/agor-ui/src/hooks/useRemoteCursors.ts

export function useRemoteCursors(boardId: BoardID) {
  const [cursors, setCursors] = useState<Map<UserID, RemoteCursor>>(new Map());
  const socket = useAgorClient();

  useEffect(() => {
    socket.on('cursor:update', cursor => {
      setCursors(prev => new Map(prev).set(cursor.user_id, cursor));
    });

    // Clean up stale cursors after 3s
    const interval = setInterval(() => {
      const now = Date.now();
      setCursors(prev => {
        const next = new Map(prev);
        for (const [userId, cursor] of next.entries()) {
          if (now - cursor.last_updated.getTime() > 3000) {
            next.delete(userId);
          }
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [boardId]);

  return { cursors };
}
```

**New Components:**

```tsx
// apps/agor-ui/src/components/Facepile/Facepile.tsx

import { Avatar, Tooltip } from 'antd';
import type { User } from '@agor/core/types';

interface FacepileProps {
  users: User[];
  maxVisible?: number; // Default: 5
}

export const Facepile: React.FC<FacepileProps> = ({ users, maxVisible = 5 }) => {
  // Use Ant Design's Avatar.Group for automatic stacking and overlap
  return (
    <Avatar.Group maxCount={maxVisible} size="default">
      {users.map(user => (
        <Tooltip key={user.user_id} title={user.name || user.email}>
          <Avatar style={{ backgroundColor: '#1890ff' }}>{user.emoji || '👤'}</Avatar>
        </Tooltip>
      ))}
    </Avatar.Group>
  );
};

// apps/agor-ui/src/components/CursorOverlay/CursorOverlay.tsx

interface CursorOverlayProps {
  cursors: Map<UserID, RemoteCursor>;
}

export const CursorOverlay: React.FC<CursorOverlayProps> = ({ cursors }) => {
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999 }}>
      {Array.from(cursors.values()).map(cursor => (
        <div
          key={cursor.user_id}
          style={{
            position: 'absolute',
            left: cursor.x,
            top: cursor.y,
            transform: 'translate(-50%, -50%)',
            transition: 'all 0.1s ease-out',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24">
            <path d="M5 3 L19 12 L12 14 L9 21 Z" fill="currentColor" />
          </svg>
          <div
            style={{
              background: 'rgba(0,0,0,0.8)',
              color: 'white',
              padding: '4px 8px',
              borderRadius: 4,
              fontSize: 12,
              marginTop: 4,
            }}
          >
            {cursor.user_emoji} {cursor.user_name}
          </div>
        </div>
      ))}
    </div>
  );
};
```

---

## Performance Considerations

### Cursor Broadcasting

**Problem:** 10 users × 20 cursor updates/sec = 200 WebSocket messages/sec

**Solutions:**

1. **Throttle client-side:** Max 20 updates/sec (50ms intervals)
2. **Only send on canvas:** Don't broadcast when cursor outside board area
3. **Hide inactive cursors:** Remove after 3s of no movement
4. **Use binary protocol:** Send `[user_id: uint8, x: uint16, y: uint16]` instead of JSON
5. **Room-based broadcasting:** Only send to users on same board

**Bandwidth Estimate:**

- JSON: ~100 bytes/message × 200 msg/sec = 20 KB/s
- Binary: ~5 bytes/message × 200 msg/sec = 1 KB/s

**Verdict:** JSON is fine for <20 users. Switch to binary for >50 users.

---

### Presence State Storage

**Options:**

**Option A: In-memory (Simple)**

- Store in daemon Map<SocketID, PresenceState>
- Lost on daemon restart (users rejoin automatically)
- No DB overhead

**Option B: Redis (Scalable)**

- Store in Redis with TTL (5s)
- Survives daemon restart
- Supports multi-instance deployments
- Redis SET/GET are fast (<1ms)

**Recommendation:** Start with in-memory, migrate to Redis if needed for scale.

---

## Open Questions

### 1. Should cursor positions be visible to everyone?

**Options:**

- **Public (Figma-style):** Everyone sees all cursors
- **Opt-in:** User can hide their cursor
- **Following mode:** Click user to follow their viewport

**Recommendation:** Public by default, add "hide my cursor" toggle later.

---

### 2. Do we need viewport sync (pan/zoom)?

**Use Case:** "Follow user X" feature where your viewport matches theirs

**Complexity:** Medium (need to sync zoom level + pan position)

**Recommendation:** Defer to Phase 3b. Not critical for MVP.

---

### 3. How to handle cursor on different screen sizes?

**Problem:** User A has 1920×1080, User B has 2560×1440. Cursor positions won't align.

**Solution:** Use React Flow's `project()` to convert screen coordinates to canvas coordinates:

```typescript
const canvasPosition = reactFlowInstance.project({ x: e.clientX, y: e.clientY });
socket.emit('cursor:move', canvasPosition);
```

This ensures cursor positions are relative to the canvas, not the viewport.

---

## Implementation Roadmap

### Phase 3a.1 - Facepile (1-2 days)

- [ ] Add PresenceManager to daemon
- [ ] Implement `board:join` / `board:leave` events
- [ ] Create `usePresence()` hook
- [ ] Build Facepile component
- [ ] Add to SessionCanvas header

### Phase 3a.2 - Cursor Swarm (2-3 days)

- [ ] Implement `cursor:move` / `cursor:update` events
- [ ] Create `useCursorBroadcast()` hook
- [ ] Create `useRemoteCursors()` hook
- [ ] Build CursorOverlay component
- [ ] Add throttling and stale cursor cleanup
- [ ] Use React Flow project() for coordinate mapping

### Phase 3a.3 - Presence Indicators (1 day)

- [ ] Implement `viewing:session` events
- [ ] Track viewing state in PresenceManager
- [ ] Add mini avatar badges to session cards
- [ ] Show tooltip with viewer names

### Phase 3a.4 - Typing Indicators (1 day)

- [ ] Implement `typing:start` / `typing:stop` events
- [ ] Track typing state in PresenceManager
- [ ] Show "User is typing..." below prompt input
- [ ] Add animated dots

**Total Estimate:** 5-7 days

---

## Success Metrics

**User Experience:**

- "It feels like Figma" - instant feedback, no lag
- Can see what teammates are working on without asking
- No confusion about who moved which session

**Technical:**

- Cursor latency <100ms (target: 50ms)
- WebSocket message rate <500/sec for 10 users
- CPU usage <5% for cursor rendering
- No memory leaks (cursors cleaned up after disconnect)

---

## Related Documents

- [../concepts/auth.md](../concepts/auth.md) - Current authentication implementation
- [multiplayer.md](multiplayer.md) - Overall multiplayer vision and completed features
- [multiplayer-auth.md](multiplayer-auth.md) - Enterprise auth features (OAuth, RBAC, organizations)

---

## References

**Cursor Libraries:**

- [perfect-cursors](https://github.com/steveruizok/perfect-cursors) - Smooth cursor interpolation
- [Liveblocks](https://liveblocks.io/) - Presence/cursor SDK (could replace custom impl)

**Presence Examples:**

- [Figma multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [Miro collaboration](https://miro.com/collaboration/)
- [PartyKit](https://partykit.io/) - Multiplayer backend framework

**WebSocket Optimization:**

- [Socket.io rooms](https://socket.io/docs/v4/rooms/)
- [Socket.io binary events](https://socket.io/docs/v4/binary-events/)
- [Redis adapter for horizontal scaling](https://socket.io/docs/v4/redis-adapter/)
