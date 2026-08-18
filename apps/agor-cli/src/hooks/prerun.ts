import { loadConfig } from '@agor/core/config';
import type { Hook } from '@oclif/core';
import { executionPolicyFor } from '../lib/execution-policy.js';
import { assertLocalContextUnlocked } from '../lib/local-context.js';

const hook: Hook<'prerun'> = async ({ Command }) => {
  const id = Command.id;
  // Daemon lifecycle commands resolve their persisted custom config path before
  // applying the same guard; a generic ~/.agor/config.yaml check would drift.
  if (!id || executionPolicyFor(id) !== 'local' || id.startsWith('daemon:')) return;
  await assertLocalContextUnlocked(await loadConfig());
};

export default hook;
