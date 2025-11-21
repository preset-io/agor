# Text Highlights - Interactive Mentions, Files, and Custom Patterns

**Status:** Proposed
**Related PR:** #297 (tagging in messages)
**Created:** 2025-01-20

## Problem

Currently, @ mention highlighting works in textareas (via overlay technique) but **does not work in rendered messages**:

1. **MarkdownRenderer** uses Streamdown library which processes markdown
2. **highlightMentionsInMarkdown** injects raw HTML (`<span style="...">`) before markdown parsing
3. Streamdown likely **escapes or ignores the raw HTML**, treating it as literal text
4. The approach is **fragile** - preprocessing conflicts with markdown syntax and code blocks

**User feedback:** "the text highlights nicely in the text area, but it doesn't seem to highlight properly in the message board, inside the message itself."

## Current State (PR #297)

✅ Autocomplete for @ mentions and files (works everywhere)
✅ @ mention highlighting in textareas (overlay technique)
✅ Red badge when current user is mentioned
❌ @ mention highlighting in rendered messages (broken)
❌ File reference highlighting (not implemented)
❌ Interactive popovers on highlights (not implemented)

## Proposed Solution: TextWithHighlights Component

Create a **reusable, extensible component** that handles multiple highlight types with interactive popovers.

### Design Goals

- ✅ **Multi-type support** - Users, files, issues, PRs, commits, etc.
- ✅ **Interactive** - Popovers with rich context (UserCard, FilePreview, etc.)
- ✅ **Code-safe** - Skip highlighting inside code blocks
- ✅ **Composable** - Mix patterns per context
- ✅ **Themeable** - Ant Design tokens, light/dark mode
- ✅ **Extensible** - Easy to add new patterns
- ✅ **Markdown-aware** - Works after markdown rendering, not before

---

## API Design

### Core Component

```tsx
interface HighlightPattern {
  type: 'mention' | 'file' | 'custom';
  regex: RegExp;

  // Visual styling
  style?: React.CSSProperties;
  className?: string;

  // Interactive behavior
  onClick?: (match: string) => void;
  onHover?: (match: string) => void;

  // Custom render function (replaces default styled span)
  render?: (match: string, index: number) => React.ReactNode;

  // Popover configuration
  popover?: {
    content: (match: string) => React.ReactNode;
    trigger?: 'hover' | 'click';
    placement?: 'top' | 'bottom' | 'left' | 'right';
  };
}

interface TextWithHighlightsProps {
  children: string | string[];
  patterns: HighlightPattern[];
  renderAs?: 'text' | 'markdown';
  isStreaming?: boolean;
  inline?: boolean;
  style?: React.CSSProperties;

  // Context data for popover content
  userById?: Map<string, User>;
  sessionId?: string | null;
  client?: AgorClient | null;
}
```

### Usage Example

```tsx
// In MessageBlock
<TextWithHighlights
  renderAs="markdown"
  patterns={[
    useMentionPattern(userById), // @mentions with UserCard popover
    useFilePattern(client, sessionId), // Files with FilePreview popover
  ]}
  isStreaming={isStreaming}
  userById={userById}
  client={client}
  sessionId={sessionId}
>
  {messageContent}
</TextWithHighlights>
```

---

## Preset Patterns

### 1. User Mentions (@username)

```tsx
export function useMentionPattern(userById: Map<string, User>): HighlightPattern {
  const { token } = theme.useToken();

  return {
    type: 'mention',
    regex: /@(?:"[^"]*"|[^\s]+)/g,

    render: (match: string, index: number) => {
      const username = match.startsWith('@"') ? match.slice(2, -1) : match.slice(1);

      const user = Array.from(userById.values()).find(
        u => u.name === username || u.email.startsWith(username)
      );

      return (
        <Popover
          key={`mention-${index}`}
          trigger="hover"
          placement="top"
          content={user ? <UserCard user={user} /> : <div>Unknown user</div>}
        >
          <span
            style={{
              backgroundColor: token.colorBgTextHover,
              borderRadius: '3px',
              padding: '0 2px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {match}
          </span>
        </Popover>
      );
    },
  };
}
```

### 2. File References (`file.ts`)

```tsx
export function useFilePattern(
  client: AgorClient | null,
  sessionId: string | null
): HighlightPattern {
  const { token } = theme.useToken();

  return {
    type: 'file',
    regex: /`[^`]+\.(ts|tsx|js|jsx|py|go|rs|md)`/g,

    render: (match: string, index: number) => {
      const filename = match.slice(1, -1);

      return (
        <Popover
          key={`file-${index}`}
          trigger="hover"
          placement="top"
          content={<FilePreviewCard filename={filename} client={client} />}
        >
          <code
            style={{
              backgroundColor: token.colorSuccessBg,
              color: token.colorSuccess,
              borderRadius: '3px',
              padding: '0 4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => console.log('Open file:', filename)}
          >
            {match}
          </code>
        </Popover>
      );
    },
  };
}
```

### 3. Future Patterns (Extensible)

```tsx
// GitHub issue numbers: #123
useIssuePattern();

// Git commits: abc123d
useCommitPattern();

// Pull requests: PR#456
usePRPattern();

// Worktrees: wt:feature-branch
useWorktreePattern();

// Task references: TASK-123
useTaskPattern();

// URLs with preview
useUrlPattern();
```

---

## Supporting Components

### UserCard Popover

```tsx
// apps/agor-ui/src/components/TextWithHighlights/cards/UserCard.tsx

interface UserCardProps {
  user: User;
}

export const UserCard: React.FC<UserCardProps> = ({ user }) => {
  const { token } = theme.useToken();

  return (
    <div style={{ padding: token.paddingSM }}>
      <Space direction="vertical" size="small">
        <Space>
          <span style={{ fontSize: 24 }}>{user.emoji || '👤'}</span>
          <div>
            <div style={{ fontWeight: 600 }}>{user.name}</div>
            <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
              {user.email}
            </div>
          </div>
        </Space>
        <Tag color="blue">{user.role}</Tag>
      </Space>
    </div>
  );
};
```

### FilePreviewCard Popover

```tsx
// apps/agor-ui/src/components/TextWithHighlights/cards/FilePreviewCard.tsx

interface FilePreviewCardProps {
  filename: string;
  client: AgorClient | null;
}

export const FilePreviewCard: React.FC<FilePreviewCardProps> = ({ filename, client }) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client) return;

    setLoading(true);
    // Fetch file preview (first 20 lines)
    client
      .service('files')
      .find({
        query: { path: filename, limit: 20 },
      })
      .then(result => setPreview(result.content))
      .finally(() => setLoading(false));
  }, [filename, client]);

  return (
    <div style={{ maxWidth: 400, maxHeight: 300 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>📄 {filename}</div>
      {loading ? (
        <Spin size="small" />
      ) : preview ? (
        <pre
          style={{
            fontSize: 12,
            overflow: 'auto',
            maxHeight: 250,
            backgroundColor: 'rgba(0,0,0,0.05)',
            padding: 8,
            borderRadius: 4,
          }}
        >
          {preview}
        </pre>
      ) : (
        <div>No preview available</div>
      )}
    </div>
  );
};
```

---

## Architecture

### Two-Phase Rendering

**Phase 1: Parse and segment**

1. Split text into segments (plain text + highlights)
2. Track code block ranges to skip highlighting inside code
3. Build segment array: `[{type: 'text', content: '...'}, {type: 'highlight', pattern: '...', content: '...'}]`

**Phase 2: Render segments**

1. For markdown: Render each segment separately through MarkdownRenderer
2. For text: Render as React elements with styled spans
3. Preserve markdown structure, apply highlights only to non-code content

### Example Processing

```
Input: "Check @john about the issue in `api/server.ts`"

After segmentation:
[
  { type: 'text', content: 'Check ' },
  { type: 'mention', content: '@john', pattern: mentionPattern },
  { type: 'text', content: ' about the issue in ' },
  { type: 'file', content: '`api/server.ts`', pattern: filePattern },
]

After rendering:
- "Check " → plain markdown
- "@john" → highlighted span with UserCard popover
- " about the issue in " → plain markdown
- "`api/server.ts`" → code style with FilePreview popover
```

---

## File Structure

```
apps/agor-ui/src/components/TextWithHighlights/
├── TextWithHighlights.tsx           # Main component
├── highlightUtils.ts                # Segmentation logic
├── patterns.ts                      # Preset patterns
├── types.ts                         # TypeScript interfaces
├── cards/
│   ├── UserCard.tsx                 # User popover content
│   ├── FilePreviewCard.tsx          # File popover content
│   ├── IssuePreview.tsx             # GitHub issue popover
│   └── LinkPreview.tsx              # URL preview
├── TextWithHighlights.stories.tsx   # Storybook examples
└── index.ts                         # Exports
```

---

## Integration Points

### Replace Usage in Components

1. **MessageBlock** (`MessageBlock.tsx:485, :571`)

   ```tsx
   // BEFORE:
   <MarkdownRenderer content={text} inline isStreaming={isStreaming} />

   // AFTER:
   <TextWithHighlights
     renderAs="markdown"
     patterns={[useMentionPattern(userById), useFilePattern(client, sessionId)]}
     isStreaming={isStreaming}
   >
     {text}
   </TextWithHighlights>
   ```

2. **CollapsibleMarkdown** (`CollapsibleMarkdown.tsx:52, :63`)
   - Update to use TextWithHighlights internally
   - Or accept patterns prop to pass through

3. **CommentsPanel** (for rendering comment content)
   - Use TextWithHighlights for comment display

4. **Task descriptions, session titles, etc.**
   - Any text that needs pattern highlighting

---

## Migration Strategy

### Phase 1: Build Foundation (Non-Breaking)

1. Create `TextWithHighlights` component
2. Create utility functions (`highlightUtils.ts`)
3. Create preset patterns (`patterns.ts`)
4. Create supporting cards (`UserCard`, `FilePreviewCard`)
5. Add Storybook stories for testing

### Phase 2: Replace MarkdownRenderer Usage

1. Update `MessageBlock` to use `TextWithHighlights`
2. Update `CollapsibleMarkdown` to use `TextWithHighlights`
3. Update `CommentsPanel` for comment rendering
4. Test in production with real messages

### Phase 3: Cleanup

1. Remove `highlightMentionsInMarkdown` function (no longer needed)
2. Keep `highlightMentionsInText` for textarea overlay (different use case)
3. Update all call sites
4. Add documentation and examples

---

## Benefits

✅ **Reusable** - Works in any text/markdown context
✅ **Multi-type support** - Users, files, issues, PRs, commits, etc.
✅ **Interactive** - Rich popovers with context on hover/click
✅ **Code-safe** - Won't corrupt code blocks
✅ **Extensible** - Easy to add new patterns
✅ **Themeable** - Ant Design tokens, light/dark mode
✅ **Type-safe** - Full TypeScript support
✅ **Async-ready** - Popovers can fetch data on demand
✅ **Composable** - Mix patterns per context
✅ **Markdown-aware** - Works with Streamdown, not against it

---

## Open Questions

1. **Performance:** How to handle long messages with many highlights?
   - Consider virtualization or lazy popover rendering

2. **Accessibility:** Keyboard navigation for highlighted elements?
   - Add ARIA labels, tab support

3. **Mobile:** Touch interactions for popovers?
   - Use 'click' trigger on mobile, 'hover' on desktop

4. **Caching:** Should we cache file previews?
   - Yes, use React Query or similar

5. **Permissions:** What if user can't access a file?
   - Show "Access denied" in popover

---

## Related Work

- **PR #297:** Tagging in messages (autocomplete + textarea highlights)
- **context/concepts/conversation-ui.md:** Task-centric conversation patterns
- **context/concepts/social-features.md:** Spatial comments and mentions

---

## Next Steps

1. **Merge PR #297** (current tagging implementation)
2. **Create new worktree** for TextWithHighlights feature
3. **Build Phase 1** (component + utilities + patterns)
4. **Test in Storybook** with various edge cases
5. **Integrate Phase 2** (replace MarkdownRenderer usage)
6. **Iterate** based on user feedback
