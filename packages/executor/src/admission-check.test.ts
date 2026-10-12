import { describe, expect, it } from 'vitest';
import { checkAdmittedClass, EXECUTOR_ADMISSION_CLASS_MISMATCH } from './admission-check.js';

describe('checkAdmittedClass', () => {
  it('refuses an agent command in a utility slot', () => {
    for (const command of ['prompt', 'agentic-tool.invoke', 'zellij.attach', 'unknown.command']) {
      expect(checkAdmittedClass(command, 'utility')).toEqual({
        admitted: 'utility',
        result: {
          success: false,
          error: {
            code: EXECUTOR_ADMISSION_CLASS_MISMATCH,
            message: 'This command was admitted as a utility and cannot run as an agent.',
          },
        },
      });
    }
  });

  it('refuses an agent command for any admitted value other than agent', () => {
    expect(checkAdmittedClass('prompt', 'bogus')?.admitted).toBe('bogus');
    expect(checkAdmittedClass('prompt', '')?.admitted).toBe('');
  });

  it('allows utility commands in any slot', () => {
    expect(checkAdmittedClass('branch.files.browse', 'utility')).toBeUndefined();
    expect(checkAdmittedClass('git.clone', 'agent')).toBeUndefined();
  });

  it('checks nothing when unset or admitted as agent', () => {
    expect(checkAdmittedClass('prompt', undefined)).toBeUndefined();
    expect(checkAdmittedClass('prompt', 'agent')).toBeUndefined();
  });
});
