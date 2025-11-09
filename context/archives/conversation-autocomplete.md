# Conversation Autocomplete

**Status:** Exploration
**Created:** 2025-10-25
**Area:** UI/UX Enhancement

## Overview

Add intelligent autocomplete to conversation inputs, similar to Claude Code, to improve developer experience when referencing files, users, and other entities in prompts.

**Key UX:** Type `@` to trigger autocomplete, showing categorized results (FILES, USERS, etc.) in a single dropdown.

## Goals

### Primary

- **Universal `@` trigger** - Single trigger for all autocomplete types (like Claude Code)
- **Categorized results** - Show FILES, USERS, etc. in organized sections
- **File path autocomplete** - Fast, accurate git-tracked file suggestions
- **User mentions** - Autocomplete Agor user names
- **Simple and reliable** - No complex caching, just live search with debouncing

### Secondary

- Session references (future)
- Board references (future)
- MCP server/tool references (future)
- Concept references from knowledge base (future)

## Design Philosophy

**Keep it simple:**

- **Single `@` trigger** for all autocomplete types (not `/` for files, `@` for users, etc.)
- **Plain text insertion** - No special markdown syntax, just insert file paths and `@username` as text
- Only autocomplete git-tracked files (`git ls-files`)
- Live backend search with 300ms debounce (no stale cache issues)
- Let git do the heavy lifting (fast, reliable, always fresh)
- Client-side filtering for users (small dataset, instant results)

## File Path Autocomplete

### The Simple Approach

**Backend:** Just run `git ls-files` with grep filtering

```bash
cd /path/to/worktree
git ls-files | grep {search} | head -20
```

**That's it!** Git handles:

- Only tracked files (no `.git`, build artifacts, etc.)
- Respects `.gitignore`
- Fast even on large repos
- Always fresh (reflects current worktree state)

### Implementation Strategy

```
User types: "@sess"
  ↓
Frontend detects @ trigger, extracts query "sess"
  ↓
Parallel search:
  - Backend: git ls-files | grep "sess" | head -7 (300ms debounce)
  - Client: Filter users by "sess" (instant, no debounce)
  ↓
Frontend combines results into categories:
  FILES:
    - src/services/sessions.ts
    - src/session.tsx
  USERS:
    - (none matching "sess")
  ↓
Shows categorized autocomplete dropdown
  ↓
User selects → insert plain text "src/services/sessions.ts"
```

**Key points:**

- **Debounce: 300ms** - Reasonable delay, doesn't feel sluggish, prevents spam
- **Limit: 20 results** - Enough to be useful, not overwhelming
- **Simple grep** - Case-insensitive substring match (could use fuzzy later)
- **Worktree-scoped** - Each session has isolated git worktree, search only that

### Backend Service

```typescript
// apps/agor-daemon/src/services/files.service.ts
import { simpleGit } from 'simple-git';

class FilesService {
  async find(params) {
    const { sessionId, search } = params.query;

    // Get session worktree path
    const session = await this.sessionService.get(sessionId);
    const worktreePath = session.worktree?.path;

    if (!worktreePath) {
      throw new Error('Session has no worktree');
    }

    if (!search) {
      return []; // Don't return all files, only search results
    }

    // Run git ls-files with grep
    const git = simpleGit(worktreePath);
    const result = await git.raw([
      'ls-files',
      // Could add fuzzy matching here later
    ]);

    // Filter and limit
    const files = result
      .split('\n')
      .filter(f => f.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 20)
      .map(path => ({
        path,
        type: 'file',
      }));

    return files;
  }
}
```

**Even simpler - just use grep directly:**

```typescript
async find(params) {
  const { sessionId, search } = params.query;

  const session = await this.sessionService.get(sessionId);
  const worktreePath = session.worktree?.path;

  if (!worktreePath || !search) return [];

  // Let bash do the work
  const git = simpleGit(worktreePath);
  const result = await git.raw([
    'ls-files',
    '-z' // null-separated for filenames with spaces
  ]);

  // Split on null, filter, limit
  const files = result
    .split('\0')
    .filter(Boolean)
    .filter(f => f.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 20)
    .map(path => ({ path, type: 'file' }));

  return files;
}
```

### Performance Analysis

**How fast is `git ls-files`?**

- Small repo (1K files): ~10ms
- Medium repo (10K files): ~50ms
- Large repo (100K files): ~200ms

**Total latency:**

- Git command: 10-200ms
- Network roundtrip: 5-20ms (localhost)
- Grep filtering: 1-5ms
- **Total: ~20-250ms** - Totally fine with 300ms debounce

**Spam prevention:**

- 300ms debounce = max 3-4 requests/second even on crazy fast typing
- Backend can easily handle this
- Cancel in-flight requests on new keystroke (abort controller)

## User Mentions

**Much simpler - small dataset, client-side search:**

```typescript
// apps/agor-ui/src/hooks/useUsers.ts
export const useUsers = () => {
  const [users, setUsers] = useState<User[]>([]);
  const client = useFeathersClient();

  useEffect(() => {
    // Fetch all users on mount (typically <100 users)
    const loadUsers = async () => {
      const result = await client.service('users').find({ query: { $limit: 100 } });
      setUsers(result.data);
    };
    loadUsers();
  }, []);

  // WebSocket: listen for new users
  useEffect(() => {
    client.service('users').on('created', user => {
      setUsers(prev => [...prev, user]);
    });
    return () => client.service('users').off('created');
  }, []);

  return { users };
};
```

**Client-side filtering:**

```typescript
const filteredUsers = users.filter(
  u =>
    u.name.toLowerCase().includes(query.toLowerCase()) ||
    u.email.toLowerCase().includes(query.toLowerCase())
);
```

No debounce needed - instant results, no backend calls.

## UI/UX Patterns

### Universal Trigger: `@`

**Like Claude Code:** Single `@` trigger for all autocomplete types.

```
User types: "@sess"
  ↓
Shows categorized results:

┌─────────────────────────────────────────┐
│ FILES                                   │
│ src/services/sessions.ts                │
│ src/components/SessionDrawer.tsx        │
│ apps/agor-daemon/src/services/          │
│   sessions.service.ts                   │
│                                         │
│ USERS                                   │
│ max (max@example.com)                   │
│                                         │
│ SESSIONS (future)                       │
│ Session abc - Fix auth bug              │
└─────────────────────────────────────────┘
```

**Interaction:**

- Type `@` to trigger autocomplete
- Continue typing to filter: `@SessionDraw` → shows matching files/users/etc.
- Arrow keys navigate across all categories
- Enter selects, inserts reference into text
- Esc dismisses

### Display Categories

**Phase 1 (MVP):**

- **FILES** - Git-tracked files from session worktree
- **USERS** - Agor users with avatars

**Phase 2:**

- **SESSIONS** - Recent sessions by title/ID
- **BOARDS** - Board names
- **CONCEPTS** - Knowledge base concepts (future)

**Visual Design:**

- Category headers: uppercase, muted color
- Max 5-7 results per category (total ~20 items)
- Icon per type (file icon, avatar, session icon)
- Keyboard navigation: ↑/↓ across all categories seamlessly

## React/Ant Design Libraries

### Selected: `@webscopeio/react-textarea-autocomplete` ✅

**Library:** [`@webscopeio/react-textarea-autocomplete`](https://github.com/webscopeio/react-textarea-autocomplete)

**Why this library:**

- Purpose-built for inline character-triggered autocomplete (GitHub-style)
- Handles all cursor positioning, text insertion, and keyboard navigation automatically
- Supports multiple triggers (`@` for now, can add more later)
- 2.3k stars, actively maintained
- Mature library that handles edge cases we'd otherwise have to implement

**Basic usage:**

```tsx
import ReactTextareaAutocomplete from "@webscopeio/react-textarea-autocomplete";
import "@webscopeio/react-textarea-autocomplete/style.css";

<ReactTextareaAutocomplete
  trigger={{
    "@": {
      dataProvider: async (token) => {
        // Combine files + users
        const [files, users] = await Promise.all([
          fetchFiles(sessionId, token),
          filterUsers(token)
        ]);

        return [
          { heading: "FILES" },
          ...files.map(f => ({ type: 'file', path: f.path, label: f.path })),
          { heading: "USERS" },
          ...users.map(u => ({ type: 'user', name: u.name, label: `${u.name} (${u.email})` }))
        ];
      },
      component: ({ entity }) => (
        <div>
          {entity.heading && <strong>{entity.heading}</strong>}
          {!entity.heading && entity.label}
        </div>
      ),
      output: (item) => item.path || `@${item.name}`
    }
  }}
/>
```

**Pros:**

- Handles all the hard parts (cursor tracking, dropdown positioning, keyboard nav, text replacement)
- Supports categorized/grouped results via special "heading" items
- Well-tested with real-world usage
- Saves 2-3 days of custom implementation work

**Cons:**

- Adds a dependency (~40KB)
- Styling requires custom CSS (not native Ant Design tokens, but we can override)
- Less control over exact UX behavior (but good defaults)

**Styling approach:**

Use CSS variables to match Ant Design tokens:

```css
.agor-textarea {
  background: var(--ant-color-bg-container);
  color: var(--ant-color-text);
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-border-radius);
  font-family: var(--ant-font-family);
  font-size: var(--ant-font-size);
  padding: var(--ant-padding-sm);
}

.rta__autocomplete {
  background: var(--ant-color-bg-elevated);
  border: 1px solid var(--ant-color-border);
  box-shadow: var(--ant-box-shadow-secondary);
  border-radius: var(--ant-border-radius);
}

.rta__list {
  max-height: 300px;
}

.rta__item {
  padding: var(--ant-padding-sm);
  color: var(--ant-color-text);
}

.rta__item--selected {
  background: var(--ant-color-primary-bg);
}
```

### Alternatives Considered

**Ant Design AutoComplete** - Does NOT support inline character-triggered autocomplete (wraps entire input only)

**react-mentions** - Heavier library, harder to style with Ant Design tokens, more complex for single-trigger use case

**Custom implementation** - Significantly more work than initially estimated (2-3 days vs 3-4 hours)

## Frontend Implementation

### Unified Autocomplete Hook

```typescript
// apps/agor-ui/src/hooks/useAutocomplete.ts
import { useState, useCallback, useRef, useMemo } from 'react';
import { debounce } from 'lodash';
import { useFeathersClient } from './useFeathersClient';
import { useUsers } from './useUsers';

export interface AutocompleteOption {
  value: string; // What gets inserted
  label: string; // Display text
  type: 'file' | 'user' | 'session' | 'board';
  category: string; // For grouping
}

export const useAutocomplete = (sessionId: string) => {
  const [fileResults, setFileResults] = useState<AutocompleteOption[]>([]);
  const [loading, setLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const client = useFeathersClient();
  const { users } = useUsers(); // Client-side user cache

  // Backend file search (debounced)
  const searchFiles = useCallback(
    debounce(async (query: string) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      if (!query) {
        setFileResults([]);
        return;
      }

      setLoading(true);
      abortControllerRef.current = new AbortController();

      try {
        const result = await client.service('files').find({
          query: { sessionId, search: query },
          signal: abortControllerRef.current.signal,
        });

        setFileResults(
          result.slice(0, 7).map(f => ({
            value: f.path,
            label: f.path,
            type: 'file',
            category: 'FILES',
          }))
        );
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('File search error:', error);
        }
      } finally {
        setLoading(false);
      }
    }, 300),
    [sessionId]
  );

  // Client-side user filtering (instant)
  const filterUsers = useCallback(
    (query: string): AutocompleteOption[] => {
      if (!query) return [];

      return users
        .filter(
          u =>
            u.name.toLowerCase().includes(query.toLowerCase()) ||
            u.email.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, 5)
        .map(u => ({
          value: `@${u.name}`,
          label: `${u.name} (${u.email})`,
          type: 'user',
          category: 'USERS',
        }));
    },
    [users]
  );

  // Combined search
  const search = useCallback(
    (query: string) => {
      searchFiles(query); // Async backend search
      return filterUsers(query); // Sync client-side filter
    },
    [searchFiles, filterUsers]
  );

  // Combine results for dropdown
  const options = useMemo(() => {
    const userResults = filterUsers(''); // Get all on empty query
    return [...fileResults, ...userResults];
  }, [fileResults, filterUsers]);

  return { options, loading, search };
};
```

### Complete Component with Ant Design AutoComplete

```tsx
// apps/agor-ui/src/components/ConversationInput.tsx
import { useState, useRef, useCallback } from 'react';
import { Input, theme } from 'antd';
import { FileOutlined, UserOutlined } from '@ant-design/icons';
import { useAutocomplete } from '../hooks/useAutocomplete';
import type { AutocompleteOption } from '../hooks/useAutocomplete';

const { TextArea } = Input;

interface ConversationInputProps {
  sessionId: string;
  onSubmit: (text: string) => void;
}

export const ConversationInput = ({ sessionId, onSubmit }: ConversationInputProps) => {
  const [value, setValue] = useState('');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState({ top: 0, left: 0 });
  const [atIndex, setAtIndex] = useState(-1);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { token } = theme.useToken();
  const { options, loading, search } = useAutocomplete(sessionId);

  // Detect @ trigger
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      const cursorPos = e.target.selectionStart || 0;
      const textBeforeCursor = newValue.substring(0, cursorPos);
      const lastAtIndex = textBeforeCursor.lastIndexOf('@');

      // Check if @ is the trigger (at start or after whitespace)
      if (lastAtIndex !== -1) {
        const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
        const isValidTrigger = charBeforeAt === ' ' || charBeforeAt === '\n' || lastAtIndex === 0;

        if (isValidTrigger) {
          const query = textBeforeCursor.substring(lastAtIndex + 1);

          // Don't show if query has spaces (@ is not a trigger anymore)
          if (!query.includes(' ') && !query.includes('\n')) {
            setAtIndex(lastAtIndex);
            setShowAutocomplete(true);
            search(query);

            // Calculate autocomplete position (simplified - would use cursor coordinates)
            setAutocompletePosition({ top: 40, left: 0 });
            return;
          }
        }
      }

      setShowAutocomplete(false);
    },
    [search]
  );

  // Handle selection
  const handleSelect = useCallback(
    (option: AutocompleteOption) => {
      if (atIndex === -1) return;

      // Replace @query with selected value
      const cursorPos = textareaRef.current?.selectionStart || 0;
      const textBeforeCursor = value.substring(0, cursorPos);
      const query = textBeforeCursor.substring(atIndex + 1);

      const newValue =
        value.substring(0, atIndex) +
        option.value +
        ' ' +
        value.substring(atIndex + 1 + query.length);

      setValue(newValue);
      setShowAutocomplete(false);

      // Move cursor after inserted value
      setTimeout(() => {
        const newCursorPos = atIndex + option.value.length + 1;
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        textareaRef.current?.focus();
      }, 0);
    },
    [value, atIndex]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !showAutocomplete) {
      e.preventDefault();
      onSubmit(value);
      setValue('');
    }

    if (e.key === 'Escape' && showAutocomplete) {
      setShowAutocomplete(false);
    }
  };

  // Group options by category
  const groupedOptions = options.reduce(
    (acc, option) => {
      if (!acc[option.category]) acc[option.category] = [];
      acc[option.category].push(option);
      return acc;
    },
    {} as Record<string, AutocompleteOption[]>
  );

  return (
    <div style={{ position: 'relative' }}>
      <TextArea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Ask a question or give instructions... (type @ for autocomplete)"
        autoSize={{ minRows: 2, maxRows: 10 }}
        style={{
          fontSize: token.fontSize,
          fontFamily: token.fontFamily,
        }}
      />

      {showAutocomplete && (
        <div
          style={{
            position: 'absolute',
            top: autocompletePosition.top,
            left: autocompletePosition.left,
            backgroundColor: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            boxShadow: token.boxShadowSecondary,
            maxHeight: 300,
            overflowY: 'auto',
            minWidth: 300,
            zIndex: 1000,
          }}
        >
          {Object.entries(groupedOptions).map(([category, items]) => (
            <div key={category}>
              <div
                style={{
                  padding: `${token.paddingXS}px ${token.paddingSM}px`,
                  fontSize: token.fontSizeSM,
                  color: token.colorTextSecondary,
                  fontWeight: 600,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                {category}
              </div>
              {items.map((option, idx) => (
                <div
                  key={`${category}-${idx}`}
                  onClick={() => handleSelect(option)}
                  style={{
                    padding: `${token.paddingSM}px`,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: token.marginXS,
                    ':hover': {
                      backgroundColor: token.colorPrimaryBg,
                    },
                  }}
                >
                  {option.type === 'file' && <FileOutlined />}
                  {option.type === 'user' && <UserOutlined />}
                  <span>{option.label}</span>
                </div>
              ))}
            </div>
          ))}
          {loading && (
            <div style={{ padding: token.paddingSM, textAlign: 'center' }}>Loading files...</div>
          )}
        </div>
      )}
    </div>
  );
};
```

## Styling Notes

All styling is inline in the component using Ant Design tokens via `theme.useToken()`. The autocomplete dropdown uses:

- `token.colorBgElevated` for background
- `token.colorBorder` for borders
- `token.boxShadowSecondary` for elevation
- `token.paddingSM` for spacing
- Category headers use `token.colorTextSecondary` and smaller font size

This ensures the autocomplete matches the rest of the Agor UI automatically.

## Backend Service Registration

```typescript
// apps/agor-daemon/src/services/index.ts
import { files } from './files/files.service';

export const services = (app: Application) => {
  app.configure(sessions);
  app.configure(tasks);
  app.configure(messages);
  app.configure(repos);
  app.configure(boards);
  app.configure(users);
  app.configure(mcpServers);
  app.configure(files); // New service
  app.configure(authentication);
};
```

## Markdown Rendering Compatibility

**Key Question:** How do autocompleted references interact with existing markdown rendering?

### Current State

- Messages are rendered as markdown
- File paths like `src/file.ts` are just plain text
- `@mentions` could conflict with markdown syntax (though `@` is not special in markdown)

### Insertion Strategy

**Option 1: Plain Text (Simplest, Recommended for MVP)**

```
User types: "@sess" → autocomplete inserts "src/services/sessions.ts"
Message stored: "Can you review src/services/sessions.ts?"
Rendered: Plain text, no special styling

User types: "@max" → autocomplete inserts "@max"
Message stored: "Hey @max, can you check this?"
Rendered: Plain text @max (markdown treats @ as regular character)
```

**Pros:**

- No markdown conflicts
- Works with existing renderer
- AI understands file paths and mentions naturally
- No database schema changes

**Cons:**

- No visual distinction (not clickable, not styled)
- Can't easily parse mentions/file refs from stored messages

**Option 2: Markdown Extensions (Future)**

```
User types: "@max" → inserts "[max](mention:user-id-123)"
User types: "@sess" → inserts "[src/sessions.ts](file:src/services/sessions.ts)"

Message stored with custom markdown links
Rendered with custom renderer that handles mention: and file: protocols
```

**Pros:**

- Clickable mentions/files
- Can style differently (badges, file icons)
- Parseable from stored messages
- Still valid markdown (degrades gracefully)

**Cons:**

- Requires custom markdown renderer plugin
- More complex insertion logic
- Could be verbose in prompt

**Option 3: Structured Message Format (Advanced)**

```typescript
interface Message {
  content: string; // Raw text: "Check @max and @file"
  mentions: {
    type: 'user' | 'file';
    text: '@max' | 'src/sessions.ts';
    ref: 'user-id-123' | 'src/services/sessions.ts';
    position: { start: number; end: number };
  }[];
}
```

**Pros:**

- Clean separation of content and metadata
- Easy to render with custom styling
- Can track which files/users were referenced

**Cons:**

- Database schema change
- More complex to maintain position offsets
- Higher implementation effort

### Recommendation for MVP

**Use Option 1 (Plain Text):**

- Insert file paths as-is: `src/services/sessions.ts`
- Insert user mentions as: `@username` (plain text, no special rendering)
- Markdown rendering is unaffected
- AI understands these references naturally

**Why it's good enough:**

- Claude Code does the same (file paths are just text in prompts)
- No markdown conflicts (`@` is not special, paths are plain strings)
- Defers complexity until we know if clickable refs are needed
- Can upgrade to Option 2 later without breaking changes

**Future enhancement:** Add custom markdown renderer plugin to:

- Detect file paths and make them clickable
- Style `@username` as badges with avatars
- Link to internal entities (sessions, boards, etc.)

### Implementation Note

For plain text approach, autocomplete just inserts strings:

```typescript
// File selected
handleSelect({ value: 'src/services/sessions.ts' });
// Inserts: "src/services/sessions.ts" (no special formatting)

// User selected
handleSelect({ value: '@max' });
// Inserts: "@max" (no special formatting)
```

That's it! No changes to message storage or markdown rendering needed.

## Open Questions

1. **Trigger pattern:** Require `@` or also auto-detect path-like strings?
   - **Suggestion:** Require `@` trigger, cleaner UX
2. **Case sensitivity:** Case-insensitive grep good enough or need fuzzy?
   - **Suggestion:** Case-insensitive is fine, fuzzy is nice-to-have
3. **Multi-file selection:** Allow inserting multiple files in one go?
   - **Suggestion:** Not needed for MVP, one at a time is fine
4. **Path format:** Insert relative path or absolute? Quotes around paths with spaces?
   - **Suggestion:** Relative path from worktree root, auto-quote if spaces
5. **Clickable references:** Do we want mentions/files to be clickable in rendered messages?
   - **Suggestion:** Not for MVP, add later with markdown plugin if needed

## Future Enhancements

### Phase 2: Fuzzy Matching

Replace simple grep with fuzzy search (e.g., `fuse.js` or `fzf`):

```
"ssd" → matches "src/services/sessions.ts"
```

### Phase 3: Smart Ranking

- Boost recently modified files
- Boost files mentioned in recent messages
- Boost files in current task context

### Phase 4: More Autocomplete Types

- `#session-id` - Recent sessions
- `#board-name` - Boards
- `$concept` - Agor concepts from knowledge base

### Phase 5: Rich Editor

If we need more features (syntax highlighting, code blocks, etc.):

- Migrate to TipTap or Lexical
- Keep same backend autocomplete logic
- Just swap React component

## Effort Estimate

**MVP Implementation:**

- Backend `/files` service: **2-3 hours**
- Frontend unified autocomplete hook: **2-3 hours**
- Custom `@` trigger detection + dropdown UI: **3-4 hours**
- Categorized results rendering: **1-2 hours**
- Keyboard navigation (arrow keys, enter, esc): **1-2 hours**
- Testing + polish: **2-3 hours**

**Total: ~1.5 days** for working file + user autocomplete

**Why relatively fast:**

- No complex caching logic
- Git does the hard work (`git ls-files`)
- Simple debounced search pattern
- Ant Design tokens handle styling
- Plain text insertion (no markdown complexity)

## Success Metrics

**Good enough when:**

- ✅ `@` trigger reliably shows autocomplete dropdown
- ✅ File results appear within 500ms of stopping typing (300ms debounce + backend latency)
- ✅ User results appear instantly (client-side filtering)
- ✅ Shows relevant git-tracked files (no build artifacts or ignored files)
- ✅ Categorized display (FILES, USERS) is clear and scannable
- ✅ Keyboard navigation works smoothly (↑/↓, Enter, Esc)
- ✅ Selected item inserts correctly and moves cursor
- ✅ No noticeable backend load (<5% CPU spike on daemon)
- ✅ Feels responsive even on repos with 10K+ files
- ✅ Works with existing markdown rendering (no conflicts)

## References

- [Git ls-files](https://git-scm.com/docs/git-ls-files) - Fast listing of tracked files
- [simple-git](https://github.com/steveukx/git-js) - Git operations in Node.js
- [Ant Design AutoComplete](https://ant.design/components/auto-complete) - Base component (for reference)
- [Lodash debounce](https://lodash.com/docs/#debounce) - Debouncing utility
- [Claude Code](https://claude.ai/claude-code) - UX inspiration for `@` trigger pattern
