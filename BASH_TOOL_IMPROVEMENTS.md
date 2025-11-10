# Bash Tool Visualization Improvements

## Summary

Improved the Bash tool rendering in the Agor UI to provide a better visual experience with proper code block styling, command headers, and collapsible output.

## Changes Made

### 1. Created Custom BashRenderer Component

**File:** `apps/agor-ui/src/components/ToolUseRenderer/renderers/BashRenderer.tsx`

**Features:**
- **Header with command**: Shows `<strong>Bash</strong> (command)` at the top
- **Proper code block rendering**: Multi-line code blocks with monospace font and `pre-wrap` whitespace
- **Collapsible output**: Uses existing `CollapsibleText`/`CollapsibleAnsiText` components (default 10 lines)
- **ANSI color support**: Automatically detects and renders ANSI escape codes for colored terminal output
- **Error state styling**: Red background tint and border for failed commands
- **Empty output handling**: Shows italic "(no output)" for commands with no output
- **Collapsible input parameters**: Existing "Show input parameters" details section below output

### 2. Registered BashRenderer in Tool Registry

**File:** `apps/agor-ui/src/components/ToolUseRenderer/renderers/index.ts`

Added `BashRenderer` to the `TOOL_RENDERERS` map so all Bash tool blocks automatically use the custom renderer.

### 3. Created Storybook Stories

**File:** `apps/agor-ui/src/components/ToolUseRenderer/renderers/BashRenderer.stories.tsx`

**Stories:**
- `SimpleCommand` - Basic ls output
- `LongOutput` - npm test with multiple lines (tests truncation)
- `WithAnsiColors` - Build output with ANSI colors
- `ErrorOutput` - TypeScript error output with is_error flag
- `NoOutput` - Empty command result
- `GitDiff` - Git diff with ANSI colors
- `VeryLongOutput` - 50+ lines to test "show more" functionality
- `WithoutCommand` - Edge case without command parameter
- `PendingExecution` - Tool use without result (still running)

## Visual Improvements

### Before
```
<code>output in single line with poor formatting</code>
```

### After
```
Bash (ls -la)
┌─────────────────────────────────────────┐
│ total 24                                │
│ drwxr-xr-x  5 user  staff   160 ...    │
│ drwxr-xr-x  8 user  staff   256 ...    │
│ -rw-r--r--  1 user  staff  1234 ...    │
│ ... (15 more lines)                     │
│ [show more]                             │
└─────────────────────────────────────────┘
```

## Technical Details

### Rendering Flow

1. **ToolUseRenderer** checks registry for custom renderer
2. **BashRenderer** is found for tool name "Bash"
3. Extracts command from `input.command`
4. Checks if output contains ANSI codes via `shouldUseAnsiRendering()`
5. Renders with either:
   - `CollapsibleAnsiText` (for ANSI color support)
   - `CollapsibleText` (for plain text with monospace styling)

### Styling Details

- **Font**: Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace
- **Whitespace**: `pre-wrap` (preserves newlines and spaces)
- **Border**: 1px solid border with rounded corners
- **Background**: Container background color
- **Error state**: Red border + 5% red background tint
- **Truncation**: Default 10 lines (configurable via `TEXT_TRUNCATION.DEFAULT_LINES`)

### Code Block vs Inline Code

The new implementation uses proper multi-line code blocks (like triple-backtick markdown blocks) instead of inline `<code>` tags. This is achieved through:

1. Block-level `<div>` container with padding and border
2. `whiteSpace: 'pre-wrap'` to preserve formatting
3. Monospace font family
4. Full-width rendering (not inline)

## Testing

### Manual Testing
1. Start UI dev server: `cd apps/agor-ui && pnpm dev`
2. Open Storybook: `pnpm storybook`
3. Navigate to "Components/ToolRenderers/BashRenderer"
4. Test different scenarios (errors, ANSI colors, long output, etc.)

### In-App Testing
View any conversation with Bash tool uses to see the improved rendering:
- Headers show command
- Output is properly formatted as code blocks
- Long output is truncated with "show more" button
- ANSI colors are rendered correctly

## Future Improvements

Potential enhancements for other tools:
- **Read**: Custom renderer showing file path header
- **Edit**: Visual diff of changes
- **Grep**: Syntax-highlighted search results
- **Git commands**: Better diff visualization
- **Test output**: Parse and highlight failures

## Files Modified/Created

```
Created:
  apps/agor-ui/src/components/ToolUseRenderer/renderers/BashRenderer.tsx
  apps/agor-ui/src/components/ToolUseRenderer/renderers/BashRenderer.stories.tsx
  BASH_TOOL_IMPROVEMENTS.md

Modified:
  apps/agor-ui/src/components/ToolUseRenderer/renderers/index.ts
```

## References

- Existing components leveraged:
  - `CollapsibleText` - apps/agor-ui/src/components/CollapsibleText/CollapsibleText.tsx
  - `CollapsibleAnsiText` - apps/agor-ui/src/components/CollapsibleText/CollapsibleAnsiText.tsx
  - `shouldUseAnsiRendering()` - apps/agor-ui/src/utils/ansi.ts
- Design patterns:
  - Tool renderer registry pattern
  - Ant Design theme tokens for consistent styling
  - TEXT_TRUNCATION constants for UX consistency
