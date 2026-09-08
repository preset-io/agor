import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { CodexRuntimeDiagnostics } from './runtime-diagnostics.js';

describe('Codex runtime diagnostics', () => {
  it('projects only allowlisted metadata without invoking hostile fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getter = vi.fn(() => {
      throw new Error('SENTINEL');
    });
    const error = Object.defineProperties(
      { code: 'ETIMEDOUT', status: 503 },
      {
        message: { get: getter },
        cause: { get: getter },
        stack: { get: getter },
        id: { get: getter },
        headers: { get: getter },
      }
    );
    try {
      const diagnostics = new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID);
      const ref = diagnostics.record('mcp_tool_failed', error);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`reference=${ref}`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=ETIMEDOUT status=503'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('task_id=task-a'));
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL');
    } finally {
      warn.mockRestore();
    }
  });

  it('caps operational events but still assigns every notice a reference and summarizes omissions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const diagnostics = new CodexRuntimeDiagnostics('session-a' as SessionID);
      const refs = Array.from({ length: 100 }, () => diagnostics.record('item_notice', {}));
      expect(new Set(refs).size).toBe(100);
      expect(warn).toHaveBeenCalledTimes(20);
      diagnostics.finish();
      expect(warn).toHaveBeenCalledTimes(21);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('omitted=80'));
      diagnostics.finish();
      expect(warn).toHaveBeenCalledTimes(21);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not reuse references or invocation context across sessions/tenants', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = new CodexRuntimeDiagnostics('session-a' as SessionID, 'task-a' as TaskID);
      const b = new CodexRuntimeDiagnostics('session-b' as SessionID, 'task-b' as TaskID);
      const refA = a.record('item_notice', {});
      const refB = b.record('item_notice', {});
      expect(refA).not.toBe(refB);
      expect(warn.mock.calls[0][0]).toContain('session_id=session-a task_id=task-a');
      expect(warn.mock.calls[1][0]).toContain('session_id=session-b task_id=task-b');
      expect(warn.mock.calls[1][0]).not.toContain(refA);
      expect(warn.mock.calls[1][0]).not.toContain('session-a');
    } finally {
      warn.mockRestore();
    }
  });
});
