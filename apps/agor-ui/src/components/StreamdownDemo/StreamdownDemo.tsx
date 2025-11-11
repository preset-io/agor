/**
 * StreamdownDemo - Showcase of Streamdown's rich markdown features
 *
 * Demonstrates:
 * - Mermaid diagrams
 * - LaTeX math expressions
 * - Code blocks with syntax highlighting
 * - GFM tables
 * - Typography features
 */

import { Card, Space, Typography } from 'antd';
import type React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';

const { Title } = Typography;

const demoContent = `# Streamdown Feature Showcase

## 🎨 Mermaid Diagrams

Here's a flowchart showing the Agor architecture:

\`\`\`mermaid
graph TD
    A[User] -->|Prompts| B[Agor UI]
    B -->|WebSocket| C[Agor Daemon]
    C -->|Manages| D[Sessions]
    C -->|Creates| E[Worktrees]
    D -->|Contains| F[Tasks]
    E -->|Tracks| G[Git Repos]

    style A fill:#f9f,stroke:#333,stroke-width:2px
    style C fill:#bbf,stroke:#333,stroke-width:2px
    style D fill:#bfb,stroke:#333,stroke-width:2px
\`\`\`

And here's a sequence diagram:

\`\`\`mermaid
sequenceDiagram
    participant User
    participant UI
    participant Daemon
    participant Agent

    User->>UI: Create Session
    UI->>Daemon: POST /sessions
    Daemon->>Agent: Initialize Claude/Codex
    Agent-->>Daemon: Ready
    Daemon-->>UI: Session Created
    UI-->>User: Show Conversation

    User->>UI: Send Prompt
    UI->>Daemon: WebSocket Message
    Daemon->>Agent: Execute Task
    Agent-->>Daemon: Stream Response
    Daemon-->>UI: Stream Events
    UI-->>User: Display Results
\`\`\`

## 📊 Math Expressions with LaTeX

Inline math: The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

Block math for more complex equations:

$$
\\begin{aligned}
\\nabla \\times \\vec{\\mathbf{B}} - \\frac{1}{c} \\frac{\\partial\\vec{\\mathbf{E}}}{\\partial t} &= \\frac{4\\pi}{c}\\vec{\\mathbf{j}} \\\\
\\nabla \\cdot \\vec{\\mathbf{E}} &= 4 \\pi \\rho \\\\
\\nabla \\times \\vec{\\mathbf{E}} + \\frac{1}{c} \\frac{\\partial\\vec{\\mathbf{B}}}{\\partial t} &= \\vec{\\mathbf{0}} \\\\
\\nabla \\cdot \\vec{\\mathbf{B}} &= 0
\\end{aligned}
$$

The Schrödinger equation:

$$
i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf{r},t) = \\left[-\\frac{\\hbar^2}{2m}\\nabla^2 + V(\\mathbf{r},t)\\right]\\Psi(\\mathbf{r},t)
$$

## 💻 Code Blocks with Syntax Highlighting

TypeScript example with automatic syntax highlighting:

\`\`\`typescript
interface Session {
  id: SessionId;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  agenticTool: 'claude-code' | 'codex' | 'gemini';
  worktreeId: WorktreeId;
  createdAt: Date;
}

async function createSession(data: Partial<Session>): Promise<Session> {
  const session = await sessionRepo.create({
    ...data,
    status: 'idle',
    createdAt: new Date(),
  });

  console.log(\`Created session: \${session.id}\`);
  return session;
}
\`\`\`

Python example:

\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

def fibonacci(n):
    """Generate Fibonacci sequence up to n terms."""
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i-1] + fib[i-2])
    return fib

# Generate and plot
terms = fibonacci(20)
plt.plot(terms, 'bo-', label='Fibonacci')
plt.xlabel('Index')
plt.ylabel('Value')
plt.title('Fibonacci Sequence')
plt.legend()
plt.grid(True)
plt.show()
\`\`\`

## 📋 GitHub Flavored Markdown Tables

| Feature | Streamdown | react-markdown | Traditional Markdown |
|---------|------------|----------------|---------------------|
| **Mermaid Diagrams** | ✅ Built-in | ❌ Requires plugin | ❌ Not supported |
| **LaTeX Math** | ✅ KaTeX | ⚠️ Plugin needed | ❌ Not supported |
| **Streaming Support** | ✅ Graceful | ❌ Breaks | ❌ N/A |
| **Code Highlighting** | ✅ Shiki | ⚠️ Basic | ⚠️ Basic |
| **Copy Buttons** | ✅ Auto | ❌ Manual | ❌ Manual |
| **GFM Tables** | ✅ Yes | ✅ Yes | ⚠️ Limited |
| **Task Lists** | ✅ Yes | ✅ Yes | ❌ No |

### Performance Comparison

| Library | Bundle Size | Render Time | Streaming |
|---------|------------|-------------|-----------|
| Streamdown | ~45KB | 12ms | ✅ |
| react-markdown | ~35KB | 18ms | ❌ |
| marked | ~20KB | 8ms | ❌ |

## ✨ Other GitHub Flavored Markdown Features

### Task Lists

- [x] Support Mermaid diagrams
- [x] Support LaTeX math
- [x] Add syntax highlighting
- [x] Handle streaming gracefully
- [ ] Add more examples
- [ ] Write documentation

### Strikethrough and Emphasis

~~This is old information~~ This is the **new** and *improved* way!

### Blockquotes

> "The best way to predict the future is to invent it."
>
> — Alan Kay

### Links and Images

Check out the [Streamdown documentation](https://streamdown.ai) for more details!

### Horizontal Rules

---

## 🎯 Why Streamdown for AI?

1. **Handles incomplete markdown**: Won't break when AI is mid-sentence
2. **Streaming optimized**: Updates smoothly as content arrives
3. **Rich features out of the box**: Mermaid, math, syntax highlighting
4. **Security first**: Built with rehype-harden
5. **Performance**: Memoized rendering for efficiency

---

*This demo showcases the power of Streamdown for rendering rich markdown content in AI-powered applications!*
`;

export const StreamdownDemo: React.FC = () => {
  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Title level={2}>Streamdown Feature Showcase</Title>

        <Card>
          <MarkdownRenderer content={demoContent} />
        </Card>
      </Space>
    </div>
  );
};
