# Native CLI Feature Gaps Analysis

Related: [[agent-interface]], [[cli]], [[architecture-api]]

**Status:** Exploration
**Date:** January 2025

---

## The Question

**What native CLI features are powerful but hard/impossible to replicate through agent SDKs?**

When Agor orchestrates agents via SDK/API instead of users interacting with native CLIs directly, what UX do we lose?

---

## Native CLI Power Features

### 1. **Rich Autocomplete & Tab Completion**

**Native Experience (Claude Code):**
```bash
claude /clear<TAB>        # Completes to /clear
claude /add-file <TAB>    # Shows file tree, autocompletes paths
claude src/co<TAB>        # Completes to src/components/
```

**What's Happening:**
- Shell integration with readline/zsh completion
- File path autocomplete via filesystem access
- Command autocomplete from known slash commands
- Context-aware suggestions (e.g., only show files in current repo)

**Current SDK Status (Researched Jan 2025):**

**✅ Custom Slash Commands Work!**
- Custom commands defined in `.claude/commands/*.md` files
- Autocomplete for custom commands **is supported** in Claude Code
- Commands discovered automatically from filesystem
- Both project-scoped (`.claude/commands/`) and personal (`~/.claude/commands/`)

**⚠️ SDK Autocomplete Exposure:**
- **GitHub Issue #4171:** "Feature Request: Autocomplete Support for Custom Slash Commands"
  - Status: **Closed** (assigned to Igor Kofman)
  - Original issue was about autocomplete not working, but workaround was moving files to `.claude/commands/`
  - **This means autocomplete already works for file-based commands!**

**SDK Likely Doesn't Expose:**
- No `getAvailableCommands()` API method documented
- No programmatic way to query slash command list
- Autocomplete happens at CLI level, not exposed to SDK

**Agor Mitigation Strategies:**

**Option 1: Filesystem-Based Discovery (Recommended)**
```typescript
// Mirror Claude Code's approach: scan .claude/commands/
async function discoverSlashCommands(
  projectPath: string
): Promise<SlashCommand[]> {
  const commandsDir = path.join(projectPath, '.claude/commands');
  const personalDir = path.join(os.homedir(), '.claude/commands');

  const commands: SlashCommand[] = [];

  // Scan both directories
  for (const dir of [commandsDir, personalDir]) {
    if (!fs.existsSync(dir)) continue;

    const files = await glob('**/*.md', { cwd: dir });

    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      const description = extractDescription(content); // Parse frontmatter

      commands.push({
        name: `/${name}`,
        description,
        path: file,
        source: dir === commandsDir ? 'project' : 'personal'
      });
    }
  }

  return commands;
}

// Extract description from markdown frontmatter or first line
function extractDescription(content: string): string {
  // Check for frontmatter
  const frontmatterMatch = content.match(/^---\n(.*?)\n---/s);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    const descMatch = yaml.match(/description:\s*(.+)/);
    if (descMatch) return descMatch[1];
  }

  // Fallback: first non-empty line
  const firstLine = content.split('\n').find(l => l.trim());
  return firstLine?.replace(/^#+\s*/, '') || 'No description';
}
```

**Pros:**
✅ Matches Claude Code's exact behavior
✅ Supports custom user commands automatically
✅ No SDK dependency
✅ Can watch filesystem for updates

**Cons:**
❌ Doesn't catch built-in commands (need hardcoded list)
❌ Only works if `.claude/` directory exists

**Option 2: Hardcoded Built-in Commands + Filesystem Discovery**
```typescript
// Known built-in Claude Code commands
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show help for Claude Code' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/add-dir', description: 'Expand your workspace' },
  { name: '/mcp', description: 'Manage Model Context Protocol servers' },
  { name: '/hooks', description: 'Set up automated shell commands' },
  { name: '/compact', description: 'Compact context window' },
  { name: '/init', description: 'Initialize Claude Code project' },
  { name: '/install-github-app', description: 'Set up GitHub PR review' }
];

// Combine built-in + custom
async function getAllCommands(projectPath: string): Promise<SlashCommand[]> {
  const customCommands = await discoverSlashCommands(projectPath);
  return [...BUILTIN_COMMANDS, ...customCommands];
}
```

**Pros:**
✅ Complete command coverage
✅ Works even without `.claude/` directory
✅ Can update built-in list as Claude adds features

**Cons:**
❌ Built-in list might get stale
❌ Manual maintenance needed

**Option 3: MCP-Based Command Discovery**
```typescript
// Claude Code supports MCP servers that expose prompts
// These become slash commands dynamically

// If SDK exposes MCP connections:
async function getMCPCommands(): Promise<SlashCommand[]> {
  const mcpServers = await getMCPServers(); // hypothetical
  const commands: SlashCommand[] = [];

  for (const server of mcpServers) {
    const prompts = await server.listPrompts(); // MCP protocol
    for (const prompt of prompts) {
      commands.push({
        name: `/${prompt.name}`,
        description: prompt.description,
        source: 'mcp',
        server: server.name
      });
    }
  }

  return commands;
}
```

**Pros:**
✅ Discovers MCP-provided commands
✅ Dynamic (updates when MCP servers change)

**Cons:**
❌ Requires SDK to expose MCP connections
❌ Unlikely to be available yet

**Recommended Approach (Hybrid):**
```typescript
// Combine all sources
async function getAutocompleteCommands(
  projectPath: string
): Promise<SlashCommand[]> {
  const builtinCommands = BUILTIN_COMMANDS;
  const customCommands = await discoverSlashCommands(projectPath);
  // const mcpCommands = await getMCPCommands(); // future

  return [
    ...builtinCommands,
    ...customCommands,
    // ...mcpCommands
  ];
}
```

**File Path Autocomplete:**
- Agor has filesystem access (can read project directory)
- Use `glob` patterns for file/directory completion
- Context-aware (only show files in repo, respect `.gitignore`)
- **Better than CLI!** Can show file previews, recent files, etc.

---

### 2. **Slash Commands (Metaprogramming the CLI)**

**Native Experience:**
```bash
claude /clear              # Clear conversation
claude /add-file foo.ts    # Add file to context
claude /search "TODO"      # Search codebase
claude /commit             # Create git commit
```

**SDK Support:**

**Scenario A: SDK Interprets Slash Commands**
```typescript
// If SDK recognizes slash commands in prompts
await session.executeTask("/clear");
await session.executeTask("/add-file src/App.tsx");
```

**Question:** Does the SDK parse `/clear` as a command, or treat it as literal text?

**Likely Answer:**
- **Claude Code SDK:** Probably **YES** - slash commands are first-class
- **OpenAI/Codex:** Probably **NO** - just sends raw text to model
- **Cursor:** Unknown, editor-centric so maybe not exposed

**Scenario B: SDK Provides Command Methods**
```typescript
// Explicit API instead of string parsing
await session.clear();
await session.addFile('src/App.tsx');
await session.search('TODO');
```

**This is better for Agor** - type-safe, no string parsing ambiguity.

**Agor Strategy:**
1. **Check if SDK supports slash commands in prompts** (send `/help` and see response)
2. **If yes:** Pass through slash commands directly
3. **If no:**
   - Implement common commands via SDK methods (if available)
   - Or emulate (e.g., `/clear` → create new session, copy context)

---

### 3. **Interactive Prompts & Confirmations**

**Native Experience:**
```bash
claude /commit
# Agent responds: "I'll create a commit. Here's the message:"
#   feat: add user authentication
#
# Proceed? (y/n): _
```

**SDK Challenge:**
- Interactive prompts require **bidirectional flow** during task execution
- Most SDKs are **unidirectional**: send prompt → wait for completion
- No mid-task user input

**Agor UI Advantage:**
We can build better UX than CLI here!

**Web UI Pattern:**
```typescript
// Agent streams response with "confirmation needed" signal
execution.onConfirmationNeeded((request) => {
  showModal({
    title: "Commit Message",
    message: request.commitMessage,
    actions: [
      { label: "Proceed", value: true },
      { label: "Edit", value: "edit" },
      { label: "Cancel", value: false }
    ],
    onConfirm: (value) => execution.respond(value)
  });
});
```

**SDK Requirements:**
- Need `TaskExecution.waitForUserInput()` capability
- Or tool-based pattern: agent uses `confirm` tool, waits for result

**Likely Reality:**
- Claude Code: Might support (uses tool-based confirmations)
- Others: Probably not built for this

**Mitigation:**
- Pre-approve common actions in Agor UI (e.g., "Auto-commit after tasks")
- Or handle confirmations client-side (parse agent's "Proceed?" text, inject response)

---

### 4. **File Watching & Live Reload**

**Native Experience:**
```bash
# Claude Code watches files, detects external changes
claude "Implement auth"
# User edits file in separate editor
# Claude notices: "I see you edited auth.ts. Should I review your changes?"
```

**SDK Limitation:**
- File watching happens in agent's process
- SDK may not expose "external file changed" events
- Agor can't replicate without agent cooperation

**Agor Workaround:**
- **Run our own file watcher** (chokidar)
- When files change, notify active sessions
- Agent may not "notice" unless we inject a message like:
  ```typescript
  session.executeTask("[System: auth.ts was modified externally]");
  ```

**Better Solution (SDK Feature Request):**
```typescript
session.onExternalFileChange((file) => {
  // Agent detected file change, asking what to do
  showNotification(`${file} changed`);
});
```

---

### 5. **Terminal Output Formatting (Colors, Spinners, Progress Bars)**

**Native CLI:**
```
🔄 Running task...
  ├─ Reading file... ✓
  ├─ Analyzing code... ⏳
  └─ Generating report...
```

**SDK Output:**
- Usually plain text or structured JSON
- No ANSI color codes
- No live-updating spinners (unless SDK streams status)

**Agor Advantage:**
**We control the UI!** Web UI can show **better** progress than terminal:
- Animated task cards
- Real-time tool call visualization
- Structured progress (not just text)

**Example:**
```typescript
execution.onToolCall((tool) => {
  updateUI({
    type: 'tool_call',
    name: tool.name,
    status: 'running',
    progress: tool.progress // if SDK provides
  });
});
```

---

### 6. **Multi-Line Editing & History**

**Native CLI:**
```bash
# Arrow up = previous command history
# Ctrl+R = fuzzy search command history
# Multi-line input with \
```

**Agor UI:**
- **Better than CLI!** Rich text editor with:
  - Syntax highlighting for code blocks
  - Markdown preview
  - Multi-line by default (no \ escaping)
  - Visual history (timeline view)
  - Search across all past prompts

---

### 7. **Context Inspection (`/context`, `/files`)**

**Native CLI:**
```bash
claude /context       # Show current context window usage
claude /files         # List files in context
claude /drop src/App.tsx  # Remove file from context
```

**SDK Support:**
- Need `session.getContext()` method
- Or `session.listFiles()` method

**Likely Reality:**
- **May not be exposed** in SDK
- Context is internal agent state

**Agor Workaround:**
- **Track context ourselves:**
  ```typescript
  // Maintain context state in Agor
  sessionState.context = {
    files: ['src/App.tsx', 'src/utils.ts'],
    concepts: ['auth', 'security'],
    tokenEstimate: 15000
  };
  ```
- When starting tasks, inject context explicitly:
  ```typescript
  const fullPrompt = `
  [Context: ${sessionState.context.files.join(', ')}]

  ${userPrompt}
  `;
  ```

**SDK Feature Request:**
```typescript
interface AgentSession {
  getContext(): Promise<ContextState>;
  addFile(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}
```

---

### 8. **Session Forking (Native Support)**

**Question:** Does Claude Code CLI support session forking natively?

**Likely Answer:** Probably not yet, it's a niche feature.

**Agor Advantage:**
- **We make forking first-class!**
- Even if SDK doesn't support it, we can emulate:
  ```typescript
  async function forkSession(sessionId: string, atTaskId: string) {
    const messages = await getMessagesUpToTask(sessionId, atTaskId);
    const newSession = await agent.createSession({
      initialMessages: messages  // If SDK supports
    });
    return newSession;
  }
  ```

---

### 9. **Agent-Specific Power Features**

**Claude Code Specific:**
- **Tool use visibility** - Shows which tools agent uses
- **Thinking blocks** - Shows reasoning (new Claude models)
- **Prompt caching** - Reduces cost for repeated context

**Cursor Specific:**
- **Inline ghost text** - Shows suggestions in editor before accepting
- **Multi-file editing** - Simultaneous edits across files
- **@-mentions** - Reference files, docs, web pages

**SDK Access:**
- **Tool use:** Likely exposed (important for tracking)
- **Thinking blocks:** May be in message stream
- **Inline suggestions:** Editor-specific, SDK won't have
- **@-mentions:** Might be prompt syntax, could work through SDK

---

### 10. **Permissions & User Consent**

**The Critical Security Question:** How does the SDK handle user permission requests?

**Native CLI Experience (Claude Code):**
```bash
# Agent wants to edit a file
Agent: "I'll update src/auth.ts..."

# CLI prompts user:
Allow Claude to edit src/auth.ts? (y/n/view): _

# User can:
- y = approve
- n = deny
- view = see diff first
```

**Similar pattern for:**
- File writes/edits
- Git operations (commit, push)
- Shell command execution
- Network requests
- File deletions

**SDK Challenge:**
How does Agor capture these permission requests and present them to the user?

---

#### Research: SDK Permission Models

**Option A: SDK Exposes Permission Hooks**

```typescript
interface IAgentClient {
  onPermissionRequest(
    handler: (request: PermissionRequest) => Promise<PermissionResponse>
  ): void;
}

interface PermissionRequest {
  type: 'file.write' | 'file.read' | 'git.commit' | 'bash.execute';
  target: string;              // File path, command, etc.
  preview?: string;            // Diff preview, command preview
  reason?: string;             // Why agent needs this
}

interface PermissionResponse {
  allowed: boolean;
  remember?: boolean;          // Remember this decision
  scope?: 'this-file' | 'all-files' | 'this-session' | 'global';
}

// Usage
agentClient.onPermissionRequest(async (request) => {
  // Show modal in Agor UI
  const response = await showPermissionModal(request);
  return response;
});
```

**Pros:**
✅ Full control over permissions
✅ Can build better UI than CLI prompts
✅ Granular permission scoping

**Cons:**
❌ Requires SDK support for permission hooks
❌ Might not exist in current SDKs

**Likelihood:**
- **Claude Code:** ⚠️ Unknown - need to check if SDK exposes this
- **OpenAI/Codex:** ❌ API doesn't have permission concept (runs in sandbox)
- **Cursor:** ⚠️ Editor-based, unclear
- **Gemini:** ❌ API-based, no permission model

---

#### **Option B: Tool-Based Permissions**

**How Claude API works:** Agent uses tools, and tools require approval.

```typescript
// Agent wants to edit file
{
  type: 'tool_use',
  name: 'Edit',
  input: {
    file_path: 'src/auth.ts',
    old_string: '...',
    new_string: '...'
  }
}

// Before executing tool, prompt user
const approved = await askUserPermission({
  tool: 'Edit',
  file: 'src/auth.ts',
  preview: generateDiff(old_string, new_string)
});

if (approved) {
  // Execute tool, return result to agent
  const result = await executeTool(tool);
  return result;
} else {
  // Deny tool execution
  return { error: 'Permission denied by user' };
}
```

**This is likely the real pattern:**
- Agent requests tool use via API
- **Agor intercepts tool call**
- Agor shows permission UI
- User approves/denies
- Agor executes or rejects tool
- Result sent back to agent

**Pros:**
✅ Works with standard tool-use pattern
✅ Granular control (per-tool-call)
✅ Can show rich previews (diffs, command explanations)

**Cons:**
❌ Adds latency (user must approve each tool)
❌ UX burden if too many prompts
❌ Need to implement all tool executors in Agor

---

#### **Option C: Pre-Approved Tool Policies**

**Instead of asking every time, set policies upfront:**

```typescript
interface ToolPolicy {
  tool: string;
  autoApprove: boolean;
  conditions?: PolicyCondition[];
}

interface PolicyCondition {
  type: 'file.pattern' | 'command.whitelist' | 'git.branch';
  value: string | RegExp;
}

// Example policies
const policies: ToolPolicy[] = [
  {
    // Auto-approve file reads
    tool: 'Read',
    autoApprove: true
  },
  {
    // Auto-approve edits to src/**
    tool: 'Edit',
    autoApprove: true,
    conditions: [
      { type: 'file.pattern', value: /^src\// }
    ]
  },
  {
    // Require approval for git push
    tool: 'Bash',
    autoApprove: false,
    conditions: [
      { type: 'command.whitelist', value: 'git push' }
    ]
  },
  {
    // Auto-approve commits on feature branches
    tool: 'Bash',
    autoApprove: true,
    conditions: [
      { type: 'command.whitelist', value: 'git commit' },
      { type: 'git.branch', value: /^feature\// }
    ]
  }
];

// Tool execution check
async function executeToolWithPolicy(tool: ToolCall) {
  const policy = findMatchingPolicy(tool, policies);

  if (policy?.autoApprove && meetsConditions(tool, policy.conditions)) {
    // Auto-approve
    return await executeTool(tool);
  } else {
    // Prompt user
    const approved = await askUserPermission(tool);
    if (approved) {
      return await executeTool(tool);
    } else {
      return { error: 'Permission denied' };
    }
  }
}
```

**Pros:**
✅ Reduces permission fatigue
✅ Fast (no blocking on every tool call)
✅ Configurable per-user, per-session, per-repo

**Cons:**
❌ Complex to configure initially
❌ Security risk if policies too permissive
❌ Need good defaults

**Recommended Approach:**
- **Ship with safe defaults** (read: auto-approve, write: prompt)
- **Learn from user** (remember approval decisions)
- **Session-specific overrides** ("Auto-approve all for this session")

---

#### **Agor Permission UI Patterns**

**Pattern 1: Modal Dialogs (Traditional)**
```
┌─────────────────────────────────────────┐
│ Permission Request                      │
├─────────────────────────────────────────┤
│ Claude Code wants to edit:              │
│ src/auth.ts                             │
│                                         │
│ Changes:                                │
│ ┌─────────────────────────────────────┐ │
│ │ - const token = null;               │ │
│ │ + const token = jwt.sign({...});   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Deny]  [View Diff]  [Approve]         │
│                                         │
│ ☐ Remember for this session            │
└─────────────────────────────────────────┘
```

**Pattern 2: Inline Tool Approval (Better UX)**
```
┌─────────────────────────────────────────┐
│ Session: Build Auth System              │
├─────────────────────────────────────────┤
│ Agent: "I'll update the auth module..." │
│                                         │
│ ⏸️  Waiting for permission:             │
│ ┌─────────────────────────────────────┐ │
│ │ 🔧 Edit src/auth.ts                 │ │
│ │ + 12 lines, - 3 lines               │ │
│ │                                     │ │
│ │ [❌ Deny]  [👁️ View]  [✅ Approve]  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Resume when approved...]               │
└─────────────────────────────────────────┘
```

**Pattern 3: Bulk Review (Advanced)**
```
Agent wants to perform 5 operations:
1. ✅ Read src/auth.ts (auto-approved)
2. ⏸️  Edit src/auth.ts (needs approval) 👁️ [Approve]
3. ⏸️  Create tests/auth.test.ts (needs approval) 👁️ [Approve]
4. ✅ Run npm test (auto-approved)
5. ⏸️  Git commit (needs approval) 👁️ [Approve]

[Approve All]  [Review Each]
```

---

#### **Default Permission Policies**

**Suggested safe defaults for Agor:**

```typescript
const DEFAULT_POLICIES: ToolPolicy[] = [
  // Safe tools: auto-approve
  { tool: 'Read', autoApprove: true },
  { tool: 'Glob', autoApprove: true },
  { tool: 'Grep', autoApprove: true },

  // Write tools: prompt (but remember decisions)
  { tool: 'Edit', autoApprove: false },
  { tool: 'Write', autoApprove: false },

  // Git reads: auto-approve
  {
    tool: 'Bash',
    autoApprove: true,
    conditions: [
      { type: 'command.whitelist', value: /^git (status|log|diff|show)/ }
    ]
  },

  // Git writes: prompt
  {
    tool: 'Bash',
    autoApprove: false,
    conditions: [
      { type: 'command.whitelist', value: /^git (commit|push|rebase)/ }
    ]
  },

  // Dangerous commands: always prompt
  {
    tool: 'Bash',
    autoApprove: false,
    conditions: [
      { type: 'command.whitelist', value: /^(rm|sudo|curl|wget)/ }
    ]
  }
];
```

---

#### **Permission Scopes**

**Where permissions apply:**

1. **Session-level:** "Auto-approve edits for this session"
2. **Repo-level:** "Always allow commits in feature branches"
3. **Global:** "Always auto-approve file reads"
4. **User preferences:** Saved across sessions

**UI for managing:**
```
Settings > Permissions

File Operations:
  Read files:        [✅ Auto-approve]
  Edit files:        [⚠️ Prompt] ⚙️ Configure
  Create files:      [⚠️ Prompt]
  Delete files:      [❌ Always deny]

Git Operations:
  Status/diff/log:   [✅ Auto-approve]
  Commit:            [⚠️ Prompt] ⚙️ Configure
  Push to main:      [❌ Always deny]
  Push to feature/*: [✅ Auto-approve]

Shell Commands:
  Whitelisted:       [✅ Auto-approve] ⚙️ Edit whitelist
  Unknown:           [⚠️ Prompt]
  Dangerous:         [❌ Always deny]
```

---

#### **Research Action Items**

**For Claude Code SDK:**
1. ✅ **Does SDK expose permission hooks?**
   - Check for `onPermissionRequest` or similar
2. ✅ **Are tool calls blocking until approved?**
   - Can we intercept before execution?
3. ✅ **Can we see tool call before agent executes?**
   - Or does agent execute and we just see result?
4. ⚠️ **What's the tool execution model?**
   - Client-side (we execute tools) vs server-side (agent executes)?

**If Claude Code runs tools server-side:**
- We have **no control** over permissions
- Agent executes tools, we just see results
- **Problem:** Can't prompt user before dangerous operations

**If Claude Code expects client to execute tools:**
- ✅ **We control execution**
- Can intercept, prompt user, then execute or deny
- This is how we want it to work

**Most likely scenario (based on Anthropic's API):**
- Agent **requests** tool use via API
- **Client executes tool** (Agor in our case)
- Client returns result to agent
- ✅ This means **we have control**

---

#### **Ideal SDK Interface for Permissions**

```typescript
interface IAgentSession {
  // When agent wants to use a tool
  onToolRequest(handler: (tool: ToolRequest) => Promise<ToolResult>): void;
}

interface ToolRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: Date;
}

// Agor implementation
session.onToolRequest(async (tool) => {
  // Check permission policy
  const policy = getPolicy(tool.name);

  if (policy.autoApprove && meetsConditions(tool, policy.conditions)) {
    // Execute without prompting
    return await executeToolInAgor(tool);
  }

  // Need user approval
  const approval = await showPermissionUI(tool);

  if (approval.allowed) {
    const result = await executeToolInAgor(tool);

    // Remember decision if requested
    if (approval.remember) {
      savePermissionDecision(tool, approval);
    }

    return result;
  } else {
    return {
      error: 'Permission denied by user',
      message: 'User rejected tool execution'
    };
  }
});
```

---

#### **Key Insights**

**The Permission Model Depends on SDK Architecture:**

**Scenario A: Client-Side Tool Execution (Best for Agor)**
- Agent requests tool use
- **Agor executes tools** (we control the filesystem, shell, etc.)
- We can intercept, prompt user, then execute
- ✅ Full permission control

**Scenario B: Server-Side Tool Execution (Bad for Agor)**
- Agent executes tools on server
- Agor just sees results
- ❌ No permission control

**Most Likely Reality (Anthropic's Claude API):**
- Client-side execution
- Agent sends tool use requests
- Client executes and returns results
- ✅ **Agor can implement full permission system**

**For OpenAI/Codex:**
- Function calling works similarly
- Client executes functions
- ✅ Agor controls execution

**For Cursor:**
- Editor-based, probably has own permission UI
- ❌ Unlikely we can intercept

---

#### **Security Best Practices**

1. **Default Deny for Writes**
   - File edits, git pushes, dangerous commands require approval

2. **Audit Log**
   - Record all tool executions (approved + denied)
   - Show in UI: "Session made 47 file edits (3 denied by user)"

3. **Sandboxing (V2)**
   - Run agents in containers with restricted filesystem access
   - Limit network access

4. **Permission Inheritance**
   - Child sessions inherit parent's permission policies
   - Can override per-session

5. **Revocation**
   - User can revoke permissions mid-session
   - "Pause session and reset permissions"

---



## Feature Gap Summary Table

| Feature | Native CLI | SDK Likely? | Agor Mitigation |
|---------|-----------|-------------|-----------------|
| **Autocomplete (commands)** | ✅ Shell integration | ⚠️ Maybe | Hardcoded + SDK query |
| **Autocomplete (files)** | ✅ Filesystem | ❌ No | Agor's own FS access |
| **Slash commands** | ✅ Built-in | ⚠️ Maybe | Pass through + emulate |
| **Interactive prompts** | ✅ Yes | ❌ Unlikely | Modal dialogs (better UX!) |
| **File watching** | ✅ Agent watches | ❌ No | Agor's own watcher |
| **Terminal formatting** | ✅ ANSI colors | ❌ Plain text | Web UI (better!) |
| **Multi-line editing** | ⚠️ With \ | ➖ N/A | Rich text editor (better!) |
| **Context inspection** | ✅ `/context` | ⚠️ Maybe | Track ourselves |
| **Session forking** | ❌ Not yet | ❌ No | Emulate via replay |
| **Tool use tracking** | ✅ Yes | ✅ Yes | SDK provides |
| **Thinking blocks** | ✅ Yes | ✅ Yes | In message stream |
| **Inline suggestions** | 🎯 Cursor only | ❌ Editor-specific | Can't replicate |

**Legend:**
- ✅ Fully supported
- ⚠️ Partial/unknown support
- ❌ Not supported
- ➖ Not applicable
- 🎯 Agent-specific feature

---

## Critical SDK Features We Need

To build Agor effectively, we **must** have these from agent SDKs:

### Tier 1: Absolutely Required
1. ✅ **Create session** - Start new agent conversations
2. ✅ **Send prompt** - Execute tasks
3. ✅ **Stream messages** - Real-time response chunks
4. ✅ **Get message history** - Retrieve conversation
5. ✅ **Tool use events** - Track agent tool calls

### Tier 2: Highly Desirable
6. ⚠️ **List sessions** - See existing agent sessions
7. ⚠️ **Import session** - Attach to existing session
8. ⚠️ **Get slash commands** - Autocomplete support
9. ⚠️ **Context state** - See files/context loaded
10. ⚠️ **Status updates** - Running/idle/completed

### Tier 3: Nice to Have
11. ❌ **Interactive prompts** - Mid-task user input
12. ❌ **Session fork** - Native fork support
13. ❌ **File watching hooks** - External change events
14. ❌ **Thinking blocks** - Reasoning visibility

---

## Research Action Items

**For Claude Code SDK:**
1. ✅ Check if slash commands work in SDK prompts
   - Test: Send `"/help"` and see if agent treats it as command
2. ✅ Check if SDK exposes `getContext()` or `listFiles()`
3. ✅ Check if SDK has `getAvailableCommands()` or similar
4. ✅ Check message format for thinking blocks
5. ⚠️ Check if interactive prompts are supported (e.g., confirmation tools)

**For Cursor:**
1. ❌ Does Cursor even have a public SDK? (May be editor-only)
2. ❌ Can we drive Cursor via API/CLI? (Research required)

**For OpenAI/Codex:**
1. ✅ API is well-documented, no slash commands
2. ✅ Streaming works via SSE
3. ❌ No session concept (we emulate)

**For Gemini:**
1. ✅ Google AI SDK documented
2. ✅ Streaming supported
3. ❌ Tool use format differs from Claude

---

## Recommended Approach

### Phase 1: Build with Claude Code Reference
- Implement `ClaudeCodeClient` using their SDK
- Document which features work vs don't
- Create feature matrix

### Phase 2: Define Capability Interface
```typescript
interface AgentCapabilities {
  // Core (all agents must support)
  core: {
    createSession: boolean;       // true for all
    sendPrompt: boolean;          // true for all
    streamMessages: boolean;      // true for all
  };

  // Extended (agent-dependent)
  extended: {
    slashCommands: boolean;       // Claude Code: yes, Codex: no
    getContext: boolean;          // Claude Code: maybe, Codex: no
    listCommands: boolean;        // Claude Code: maybe, others: no
    interactivePrompts: boolean;  // All: probably no
    fileWatching: boolean;        // All: no (Agor handles)
  };

  // Agent-specific
  agentSpecific: {
    thinkingBlocks?: boolean;     // Claude only
    inlineEdits?: boolean;        // Cursor only
    promptCaching?: boolean;      // Claude only
  };
}
```

### Phase 3: Graceful Degradation
- Agor UI adapts based on capabilities
- Features unavailable from SDK → emulate or skip
- Show capability badges in UI ("🔄 Live file watching" if supported)

### Phase 4: SDK Advocacy
- **Engage with SDK maintainers** (Anthropic, OpenAI, Google, Cursor)
- Request missing features with use cases
- Contribute PRs if open source
- Share Agor's needs as representative of "orchestration layer" use case

---

## Key Insights

**Where Agor Can Be Better Than Native CLI:**
1. 🎨 **Rich UI** - Better than terminal colors/spinners
2. 🌳 **Session trees** - Visual genealogy, fork/spawn
3. 📊 **Analytics** - Tool use charts, session metrics
4. 🔍 **Search** - Cross-session search, pattern finding
5. 👥 **Multiplayer** - Real-time collaboration (V2)
6. 📝 **Reports** - Auto-generated learnings
7. 🧩 **Concepts** - Modular context management

**Where Native CLI Wins (If SDK Lacks Features):**
1. ⚡ **Autocomplete** - Shell integration is hard to beat
2. 🔧 **Slash commands** - If SDK doesn't parse them
3. 📁 **File watching** - Agent's native integration
4. 🎯 **Editor integration** - Cursor's inline suggestions

**The Bet:**
Even if we lose 10-20% of native CLI features, we gain **massive value** from orchestration, visualization, and collaboration. Users will choose Agor for the **meta-level benefits**, not just as a CLI replacement.

---

## Next Steps

1. **Prototype with Claude Code SDK** - Validate assumptions
2. **Document feature matrix** - What works, what doesn't
3. **Design fallback UX** - How to handle missing features
4. **Engage with SDK teams** - Request critical features
5. **Build Agor's strengths** - Focus on what we do better

---

See also:
- [[agent-interface]] - Agent client abstraction design
- [[cli]] - Agor's own CLI design
- [[architecture-api]] - How Agor integrates with agents
