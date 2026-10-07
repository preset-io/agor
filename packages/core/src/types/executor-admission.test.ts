import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_ADMISSION_CLASSES,
  EXECUTOR_COMMAND_ADMISSION,
  executorAdmissionClassFor,
} from './executor-admission';

describe('executor admission classes', () => {
  it('classes the agent turn, auxiliary agent calls and web terminals as agent', () => {
    const agents = Object.entries(EXECUTOR_COMMAND_ADMISSION)
      .filter(([, admissionClass]) => admissionClass === 'agent')
      .map(([command]) => command)
      .sort();
    expect(agents).toEqual(['agentic-tool.invoke', 'prompt', 'zellij.attach', 'zellij.tab']);
    expect(Object.keys(EXECUTOR_COMMAND_ADMISSION)).toHaveLength(32);
    for (const admissionClass of Object.values(EXECUTOR_COMMAND_ADMISSION)) {
      expect(EXECUTOR_ADMISSION_CLASSES).toContain(admissionClass);
    }
  });

  it('returns the mapped class for a registered command', () => {
    expect(executorAdmissionClassFor('prompt')).toBe('agent');
    expect(executorAdmissionClassFor('git.clone')).toBe('utility');
    expect(executorAdmissionClassFor('branch.delete')).toBe('utility');
    expect(executorAdmissionClassFor('branch.archive')).toBe('utility');
  });

  it.each([undefined, null, 42, '', 'unknown.command', 'toString', '__proto__', 'constructor'])(
    'fails closed to agent for %s',
    (command) => {
      expect(executorAdmissionClassFor(command)).toBe('agent');
    }
  );
});
