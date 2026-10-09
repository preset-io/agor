import type { BranchEnvironmentInstance } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  getEnvironmentProblemLabel,
  getEnvironmentProblemLine,
  getEnvironmentProblemNotice,
} from './environmentStatusCopy';

type Command = NonNullable<BranchEnvironmentInstance['last_command']>;

const settled = (
  action: Command['action'],
  status: 'failed' | 'unknown',
  message = 'exit 1'
): BranchEnvironmentInstance => ({
  status: 'error',
  last_error: message,
  last_command: { action, status, timestamp: '2026-10-09T10:00:00Z', message },
});

describe('environment status copy', () => {
  it.each([
    {
      env: settled('start', 'failed'),
      label: "Didn't start",
      line: "The environment didn't start. Check the logs.",
      notice: {
        type: 'error',
        message: "The environment didn't start.",
        details: [{ label: 'Output', value: 'exit 1', code: true }],
      },
    },
    {
      env: settled('stop', 'failed'),
      label: "Didn't stop",
      line: "The environment didn't stop. Check the logs.",
      notice: {
        type: 'error',
        message: "The environment didn't stop.",
        details: [{ label: 'Output', value: 'exit 1', code: true }],
      },
    },
    {
      env: settled('restart', 'failed'),
      label: "Didn't restart",
      line: "The environment didn't restart. Check the logs.",
      notice: {
        type: 'error',
        message: "The environment didn't restart.",
        details: [{ label: 'Output', value: 'exit 1', code: true }],
      },
    },
    {
      env: settled('nuke', 'failed'),
      label: "Nuke didn't finish",
      line: "The nuke didn't finish. Check the logs.",
      notice: {
        type: 'error',
        message: "The nuke didn't finish.",
        details: [{ label: 'Output', value: 'exit 1', code: true }],
      },
    },
    {
      env: settled('start', 'unknown', 'Launch handoff failed or timed out.'),
      label: 'Not confirmed',
      line: "Agor couldn't confirm the last start. Check the logs before you try again.",
      notice: {
        type: 'warning',
        message:
          "Agor couldn't confirm the environment started. Check the logs before you try again.",
        details: [{ label: 'Result', value: 'Launch handoff failed or timed out.', code: true }],
      },
    },
    {
      env: settled('stop', 'unknown', 'No result'),
      label: 'Not confirmed',
      line: "Agor couldn't confirm the last stop. Check the logs before you try again.",
      notice: {
        type: 'warning',
        message:
          "Agor couldn't confirm the environment stopped. Check the logs before you try again.",
        details: [{ label: 'Result', value: 'No result', code: true }],
      },
    },
    {
      env: settled('nuke', 'unknown', 'No result'),
      label: 'Not confirmed',
      line: "Agor couldn't confirm the last nuke. Check the logs before you try again.",
      notice: {
        type: 'warning',
        message: "Agor couldn't confirm the last nuke. Check the logs before you try again.",
        details: [{ label: 'Result', value: 'No result', code: true }],
      },
    },
    {
      env: { status: 'error', last_error: 'spawn ENOENT' },
      label: null,
      line: 'The environment reported an error.',
      notice: {
        type: 'error',
        message: 'The environment reported an error.',
        details: [{ label: 'Error', value: 'spawn ENOENT', code: true }],
      },
    },
    {
      env: {
        status: 'running',
        last_health_check: { status: 'unhealthy', timestamp: 'now', message: 'HTTP 503' },
      },
      label: 'Health check failed',
      line: 'Running, but the health check failed. (HTTP 503)',
      notice: {
        type: 'warning',
        message: 'Running, but the health check failed.',
        details: [{ label: 'Health check', value: 'HTTP 503', code: true }],
      },
    },
    {
      env: { status: 'stopped', last_error: 'old failure' },
      label: null,
      line: null,
      notice: null,
    },
    {
      env: {
        ...settled('start', 'failed'),
        status: 'starting',
        command_attempt: { id: 'next' },
      } as BranchEnvironmentInstance,
      label: null,
      line: null,
      notice: null,
    },
  ] satisfies Array<{
    env: BranchEnvironmentInstance;
    label: string | null;
    line: string | null;
    notice: ReturnType<typeof getEnvironmentProblemNotice>;
  }>)('$line', ({ env, label, line, notice }) => {
    expect(getEnvironmentProblemLabel(env)).toBe(label);
    expect(getEnvironmentProblemLine(env)).toBe(line);
    expect(getEnvironmentProblemNotice(env)).toEqual(notice);
  });
});
