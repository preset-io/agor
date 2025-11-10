import type { Meta, StoryObj } from '@storybook/react';
import { BashRenderer } from './BashRenderer';

const meta: Meta<typeof BashRenderer> = {
  title: 'Components/ToolRenderers/BashRenderer',
  component: BashRenderer,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof BashRenderer>;

export const SimpleCommand: Story = {
  args: {
    toolUseId: 'bash-1',
    input: {
      command: 'ls -la',
    },
    result: {
      content: `total 24
drwxr-xr-x  5 user  staff   160 Jan  9 10:30 .
drwxr-xr-x  8 user  staff   256 Jan  9 10:29 ..
-rw-r--r--  1 user  staff  1234 Jan  9 10:30 README.md
-rw-r--r--  1 user  staff   567 Jan  9 10:30 package.json
drwxr-xr-x  3 user  staff    96 Jan  9 10:30 src`,
      is_error: false,
    },
  },
};

export const LongOutput: Story = {
  args: {
    toolUseId: 'bash-2',
    input: {
      command: 'npm test',
    },
    result: {
      content: `> test
> jest

PASS  src/components/Button.test.tsx
PASS  src/components/Input.test.tsx
PASS  src/components/Form.test.tsx
PASS  src/utils/validation.test.ts
PASS  src/utils/format.test.ts
PASS  src/hooks/useAuth.test.ts
PASS  src/hooks/useData.test.ts
PASS  src/services/api.test.ts
PASS  src/services/storage.test.ts
PASS  src/store/actions.test.ts
PASS  src/store/reducers.test.ts
PASS  src/pages/Home.test.tsx
PASS  src/pages/Dashboard.test.tsx
PASS  src/pages/Settings.test.tsx
PASS  src/pages/Profile.test.tsx

Test Suites: 15 passed, 15 total
Tests:       87 passed, 87 total
Snapshots:   0 total
Time:        12.345 s
Ran all test suites.`,
      is_error: false,
    },
  },
};

export const WithAnsiColors: Story = {
  args: {
    toolUseId: 'bash-3',
    input: {
      command: 'npm run build',
    },
    result: {
      content: `\x1b[32m✓\x1b[0m Building for production...
\x1b[36minfo\x1b[0m - Compiling TypeScript files...
\x1b[32m✓\x1b[0m TypeScript compilation complete
\x1b[36minfo\x1b[0m - Bundling assets...
\x1b[32m✓\x1b[0m Assets bundled successfully
\x1b[36minfo\x1b[0m - Optimizing output...
\x1b[32m✓\x1b[0m Build complete in 8.42s

\x1b[1mOutput:\x1b[0m
  \x1b[36mdist/index.js\x1b[0m      245.3 KB
  \x1b[36mdist/vendor.js\x1b[0m    1.2 MB
  \x1b[36mdist/styles.css\x1b[0m   89.4 KB`,
      is_error: false,
    },
  },
};

export const ErrorOutput: Story = {
  args: {
    toolUseId: 'bash-4',
    input: {
      command: 'npm run typecheck',
    },
    result: {
      content: `> typecheck
> tsc --noEmit

src/components/Header.tsx:15:7 - error TS2322: Type 'string' is not assignable to type 'number'.

15   const count: number = "hello";
         ~~~~~

src/utils/api.ts:42:18 - error TS2345: Argument of type 'undefined' is not assignable to parameter of type 'string'.

42   fetchData(undefined);
                ~~~~~~~~

Found 2 errors in 2 files.`,
      is_error: true,
    },
  },
};

export const NoOutput: Story = {
  args: {
    toolUseId: 'bash-5',
    input: {
      command: 'git add .',
    },
    result: {
      content: '',
      is_error: false,
    },
  },
};

export const GitDiff: Story = {
  args: {
    toolUseId: 'bash-6',
    input: {
      command: 'git diff',
    },
    result: {
      content: `\x1b[1mdiff --git a/src/App.tsx b/src/App.tsx\x1b[0m
\x1b[1mindex 1234567..abcdefg 100644\x1b[0m
\x1b[1m--- a/src/App.tsx\x1b[0m
\x1b[1m+++ b/src/App.tsx\x1b[0m
\x1b[36m@@ -10,7 +10,7 @@\x1b[0m function App() {
   return (
     <div className="App">
       <Header />
\x1b[31m-      <MainContent />\x1b[0m
\x1b[32m+      <MainContent theme="dark" />\x1b[0m
       <Footer />
     </div>
   );`,
      is_error: false,
    },
  },
};

export const VeryLongOutput: Story = {
  args: {
    toolUseId: 'bash-7',
    input: {
      command: 'find . -type f',
    },
    result: {
      content: Array.from({ length: 50 }, (_, i) => `./src/components/Component${i}.tsx`).join('\n'),
      is_error: false,
    },
  },
};

export const WithoutCommand: Story = {
  args: {
    toolUseId: 'bash-8',
    input: {},
    result: {
      content: 'Some output without a command',
      is_error: false,
    },
  },
};

export const PendingExecution: Story = {
  args: {
    toolUseId: 'bash-9',
    input: {
      command: 'npm install',
    },
    // No result = still executing
  },
};
