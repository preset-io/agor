/**
 * TodoListRenderer Storybook Stories
 */

import type { Meta, StoryObj } from '@storybook/react';
import { TodoListRenderer } from './TodoListRenderer';

const meta = {
  title: 'Tool Renderers/TodoListRenderer',
  component: TodoListRenderer,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof TodoListRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Simple todo list with mixed statuses
 */
export const Default: Story = {
  args: {
    toolUseId: 'tool_use_1',
    input: {
      todos: [
        {
          content: 'Explore current tool use rendering in UI',
          activeForm: 'Exploring current tool use rendering',
          status: 'completed',
        },
        {
          content: 'Understand TodoWrite tool data structure',
          activeForm: 'Understanding TodoWrite data structure',
          status: 'completed',
        },
        {
          content: 'Design extensible tool renderer architecture',
          activeForm: 'Designing tool renderer architecture',
          status: 'in_progress',
        },
        {
          content: 'Implement TodoList component',
          activeForm: 'Implementing TodoList component',
          status: 'pending',
        },
        {
          content: 'Add visual polish and animations',
          activeForm: 'Adding visual polish and animations',
          status: 'pending',
        },
      ],
    },
  },
};

/**
 * All completed tasks
 */
export const AllCompleted: Story = {
  args: {
    toolUseId: 'tool_use_2',
    input: {
      todos: [
        {
          content: 'Set up project structure',
          activeForm: 'Setting up project structure',
          status: 'completed',
        },
        {
          content: 'Install dependencies',
          activeForm: 'Installing dependencies',
          status: 'completed',
        },
        {
          content: 'Configure TypeScript',
          activeForm: 'Configuring TypeScript',
          status: 'completed',
        },
        {
          content: 'Run initial build',
          activeForm: 'Running initial build',
          status: 'completed',
        },
      ],
    },
  },
};

/**
 * All pending tasks
 */
export const AllPending: Story = {
  args: {
    toolUseId: 'tool_use_3',
    input: {
      todos: [
        {
          content: 'Write unit tests',
          activeForm: 'Writing unit tests',
          status: 'pending',
        },
        {
          content: 'Add integration tests',
          activeForm: 'Adding integration tests',
          status: 'pending',
        },
        {
          content: 'Update documentation',
          activeForm: 'Updating documentation',
          status: 'pending',
        },
      ],
    },
  },
};

/**
 * Single task in progress
 */
export const SingleInProgress: Story = {
  args: {
    toolUseId: 'tool_use_4',
    input: {
      todos: [
        {
          content: 'Fetch data from API',
          activeForm: 'Fetching data from API',
          status: 'in_progress',
        },
      ],
    },
  },
};

/**
 * Long task list (realistic scenario)
 */
export const LongList: Story = {
  args: {
    toolUseId: 'tool_use_5',
    input: {
      todos: [
        {
          content: 'Initialize database connection',
          activeForm: 'Initializing database connection',
          status: 'completed',
        },
        {
          content: 'Run database migrations',
          activeForm: 'Running database migrations',
          status: 'completed',
        },
        {
          content: 'Seed test data',
          activeForm: 'Seeding test data',
          status: 'completed',
        },
        {
          content: 'Set up authentication middleware',
          activeForm: 'Setting up authentication middleware',
          status: 'completed',
        },
        {
          content: 'Implement user registration endpoint',
          activeForm: 'Implementing user registration endpoint',
          status: 'in_progress',
        },
        {
          content: 'Add email verification',
          activeForm: 'Adding email verification',
          status: 'pending',
        },
        {
          content: 'Configure password reset flow',
          activeForm: 'Configuring password reset flow',
          status: 'pending',
        },
        {
          content: 'Write API documentation',
          activeForm: 'Writing API documentation',
          status: 'pending',
        },
        {
          content: 'Deploy to staging',
          activeForm: 'Deploying to staging',
          status: 'pending',
        },
      ],
    },
  },
};

/**
 * Realistic task descriptions
 */
export const RealisticTasks: Story = {
  args: {
    toolUseId: 'tool_use_6',
    input: {
      todos: [
        {
          content: 'Read existing SessionDrawer implementation',
          activeForm: 'Reading existing SessionDrawer implementation',
          status: 'completed',
        },
        {
          content: 'Analyze message rendering flow',
          activeForm: 'Analyzing message rendering flow',
          status: 'completed',
        },
        {
          content: 'Design TodoList component with checkbox indicators',
          activeForm: 'Designing TodoList component',
          status: 'completed',
        },
        {
          content: 'Implement extensible tool renderer registry',
          activeForm: 'Implementing extensible tool renderer registry',
          status: 'in_progress',
        },
        {
          content: 'Create Storybook stories for TodoListRenderer',
          activeForm: 'Creating Storybook stories',
          status: 'pending',
        },
        {
          content: 'Test integration with live sessions',
          activeForm: 'Testing integration with live sessions',
          status: 'pending',
        },
      ],
    },
  },
};

/**
 * Empty todo list (edge case)
 */
export const Empty: Story = {
  args: {
    toolUseId: 'tool_use_7',
    input: {
      todos: [],
    },
  },
};

/**
 * Display-only `stopped` status — applied by StickyTodoRenderer when the
 * parent task was halted by the user but items remain in_progress.
 */
export const StoppedItems: Story = {
  args: {
    toolUseId: 'tool_use_8',
    input: {
      todos: [
        {
          content: 'Run database migrations',
          activeForm: 'Running database migrations',
          status: 'completed',
        },
        {
          content: 'Implement user registration endpoint',
          activeForm: 'Implementing user registration endpoint',
          status: 'stopped',
        },
        {
          content: 'Add email verification',
          activeForm: 'Adding email verification',
          status: 'pending',
        },
      ],
    },
  },
};

/**
 * Display-only `unknown` status — applied by StickyTodoRenderer when the
 * parent task ended (completed/failed/timed out) without the agent updating
 * an item that was still in_progress.
 */
export const UnknownItems: Story = {
  args: {
    toolUseId: 'tool_use_9',
    input: {
      todos: [
        {
          content: 'Run database migrations',
          activeForm: 'Running database migrations',
          status: 'completed',
        },
        {
          content: 'Implement user registration endpoint',
          activeForm: 'Implementing user registration endpoint',
          status: 'unknown',
        },
        {
          content: 'Add email verification',
          activeForm: 'Adding email verification',
          status: 'pending',
        },
      ],
    },
  },
};
