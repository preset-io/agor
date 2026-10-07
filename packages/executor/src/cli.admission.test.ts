/**
 * The stdin entry point refuses an agent command admitted as a utility before
 * dispatching anything or applying payload env.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(async () => ({ success: true, data: {} })),
  executorStart: vi.fn(async () => undefined),
  publisherFinal: vi.fn(async () => undefined),
}));

vi.mock('@agor/core/templates/handlebars-helpers', () => ({
  registerHandlebarsHelpers: vi.fn(),
}));
vi.mock('./handlers/sdk/tool-registry.js', () => ({
  initializeToolRegistry: vi.fn(async () => undefined),
  ToolRegistry: { has: () => true, getAll: () => ['claude-code'] },
}));
vi.mock('./index.js', () => ({
  AgorExecutor: class {
    start = mocks.executorStart;
  },
}));
vi.mock('./commands/index.js', () => ({
  executeCommand: mocks.executeCommand,
  executeInteractiveCommand: vi.fn(),
  getRegisteredCommands: () => [],
}));
vi.mock('./executor-response.js', () => ({
  ExecutorResponsePublisher: class {
    final = mocks.publisherFinal;
  },
}));

const responseDescriptor = {
  protocol: 'executor-response-v1',
  profile: 'terminal',
  requestId: '550e8400-e29b-41d4-a716-446655440001',
  url: 'http://daemon.internal:3030/executor/responses/request',
  token: 'a'.repeat(43),
  deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  maxResponseBytes: 1024,
};

const promptPayload = {
  command: 'prompt',
  sessionToken: 'jwt',
  params: {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    taskId: '550e8400-e29b-41d4-a716-446655440001',
    prompt: 'Hello',
    tool: 'claude-code',
    cwd: '/tmp',
  },
};

const browsePayload = {
  command: 'branch.files.browse',
  executorMode: 'request',
  executorResponse: responseDescriptor,
  sessionToken: 'jwt',
  params: { branchId: '550e8400-e29b-41d4-a716-446655440000' },
};

const savedArgv = process.argv;
const savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const savedAdmission = process.env.AGOR_EXECUTOR_ADMISSION_CLASS;
let exits: number[];
let stderr: string[];

async function runStdin(payload: unknown): Promise<void> {
  process.argv = ['node', 'cli.js', '--stdin'];
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([Buffer.from(JSON.stringify(payload))]),
  });
  vi.resetModules();
  await import('./cli.js');
  await vi.waitFor(() => {
    expect(exits.length + mocks.executorStart.mock.calls.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  exits = [];
  stderr = [];
  vi.clearAllMocks();
  // The first exit ends the run; later calls come from the CLI's own catch.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    if (exits.length === 1) throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = savedArgv;
  if (savedStdin) Object.defineProperty(process, 'stdin', savedStdin);
  if (savedAdmission === undefined) delete process.env.AGOR_EXECUTOR_ADMISSION_CLASS;
  else process.env.AGOR_EXECUTOR_ADMISSION_CLASS = savedAdmission;
});

describe('handleStdinMode admission check', () => {
  it('runs nothing for a prompt admitted as a utility, whatever the payload claims', async () => {
    process.env.AGOR_EXECUTOR_ADMISSION_CLASS = 'utility';
    await runStdin({
      ...promptPayload,
      admissionClass: 'utility',
      env: { AGOR_EXECUTOR_ADMISSION_CLASS: 'agent' },
    });

    expect(exits[0]).toBe(1);
    expect(mocks.executorStart).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(process.env.AGOR_EXECUTOR_ADMISSION_CLASS).toBe('utility');
    expect(stderr).toContain(
      '[executor] admission class mismatch: admitted=utility command_class=agent'
    );
  });

  it('answers a request through its response channel', async () => {
    process.env.AGOR_EXECUTOR_ADMISSION_CLASS = 'utility';
    await runStdin({
      ...browsePayload,
      command: 'agentic-tool.invoke',
      params: { tool: 'opencode', request: {} },
    });

    expect(exits[0]).toBe(1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.publisherFinal).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'EXECUTOR_ADMISSION_CLASS_MISMATCH',
        message: 'This command was admitted as a utility and cannot run as an agent.',
      },
    });
  });

  it('runs a utility command admitted as a utility', async () => {
    process.env.AGOR_EXECUTOR_ADMISSION_CLASS = 'utility';
    await runStdin(browsePayload);

    expect(exits[0]).toBe(0);
    expect(mocks.executeCommand).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'agent'])(
    'starts a prompt when the admitted class is %s',
    async (admitted) => {
      if (admitted === undefined) delete process.env.AGOR_EXECUTOR_ADMISSION_CLASS;
      else process.env.AGOR_EXECUTOR_ADMISSION_CLASS = admitted;
      await runStdin(promptPayload);

      expect(mocks.executorStart).toHaveBeenCalledOnce();
      expect(exits).toEqual([]);
    }
  );
});
