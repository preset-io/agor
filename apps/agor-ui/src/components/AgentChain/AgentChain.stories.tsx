import type { Message } from '@agor/core/types';
import type { Meta, StoryObj } from '@storybook/react';
import { AgentChain } from './AgentChain';

const meta: Meta<typeof AgentChain> = {
  title: 'Components/AgentChain',
  component: AgentChain,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof AgentChain>;

// Helper to create messages
const createMessage = (role: 'assistant' | 'user', content: Message['content']): Message => ({
  id: `msg-${Math.random()}`,
  role,
  content,
  created_at: new Date().toISOString(),
});

export const WithBashCommand: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'text',
          text: 'Let me check the current git status',
        },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: {
            command: 'git status',
            description: 'Check git repository status',
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: `On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean`,
          is_error: false,
        },
      ]),
    ],
  },
};

export const WithLongBashCommand: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'text',
          text: 'Let me run a complex Docker command',
        },
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'Bash',
          input: {
            command:
              'docker run -d --name my-container -p 8080:80 -e NODE_ENV=production -v /host/path:/container/path --restart unless-stopped my-image:latest',
            description: 'Start production container with volume mounts',
            timeout: 30000,
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-2',
          content: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
          is_error: false,
        },
      ]),
    ],
  },
};

export const WithBashInBackground: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'tool_use',
          id: 'tool-3',
          name: 'Bash',
          input: {
            command: 'npm run dev',
            description: 'Start development server',
            run_in_background: true,
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-3',
          content: `> dev
> vite

  VITE v5.0.0  ready in 234 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose`,
          is_error: false,
        },
      ]),
    ],
  },
};

export const WithBashError: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'tool_use',
          id: 'tool-4',
          name: 'Bash',
          input: {
            command: 'npm run typecheck',
            description: 'Check TypeScript types',
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-4',
          content: `> typecheck
> tsc --noEmit

src/App.tsx:15:7 - error TS2322: Type 'string' is not assignable to type 'number'.

Found 1 error.`,
          is_error: true,
        },
      ]),
    ],
  },
};

export const MultipleTools: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'text',
          text: 'Let me check the git status and then look at recent commits',
        },
        {
          type: 'tool_use',
          id: 'tool-5',
          name: 'Bash',
          input: {
            command: 'git status --short',
            description: 'Check modified files',
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-5',
          content: ` M src/App.tsx
 M src/utils/api.ts`,
          is_error: false,
        },
      ]),
      createMessage('assistant', [
        {
          type: 'tool_use',
          id: 'tool-6',
          name: 'Bash',
          input: {
            command: 'git log --oneline -n 5',
            description: 'Show recent commits',
          },
        },
        {
          type: 'tool_use',
          id: 'tool-7',
          name: 'Read',
          input: {
            file_path: '/Users/max/code/project/src/App.tsx',
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-6',
          content: `abc1234 Fix authentication bug
def5678 Add new feature
ghi9012 Update dependencies
jkl3456 Refactor API calls
mno7890 Initial commit`,
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'tool-7',
          content: `import React from 'react';

function App() {
  return <div>Hello World</div>;
}

export default App;`,
          is_error: false,
        },
      ]),
    ],
  },
};

export const BashWithPipeAndChaining: Story = {
  args: {
    messages: [
      createMessage('assistant', [
        {
          type: 'tool_use',
          id: 'tool-8',
          name: 'Bash',
          input: {
            command: 'cat package.json | grep "dependencies" -A 10 | sort',
            description: 'Extract and sort dependencies from package.json',
          },
        },
      ]),
      createMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-8',
          content: `  "dependencies": {
    "@ant-design/icons": "^5.0.0",
    "antd": "^5.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }`,
          is_error: false,
        },
      ]),
    ],
  },
};
