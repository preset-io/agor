/** Synthetic-provider child for the registered daemon/executor PG smoke test. */

import { TaskStatus } from '@agor/core/types';
import { ToolRegistry } from '../src/handlers/sdk/tool-registry.js';
import { AgorExecutor, type ExecutorConfig } from '../src/index.js';
import type { ManagedOpenCodeNativeStateManifest } from '../src/managed-opencode-admission.js';

const configText = process.env.AGOR_TEST_EXECUTOR_CONFIG;
const expectedText = process.env.AGOR_TEST_EXPECTED_INPUT;
if (!configText || !expectedText) throw new Error('Missing synthetic executor test configuration');
const config = JSON.parse(configText) as ExecutorConfig;
const expected = JSON.parse(expectedText) as ManagedOpenCodeNativeStateManifest;
const canonical = (value: object | null) =>
  JSON.stringify(
    value && Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  );

// The outer executor still owns the real socket, claim, begin, heartbeat,
// watchdog, and completion lifecycle. Only the live provider is replaced.
ToolRegistry.execute = async (_tool, params) => {
  try {
    const grant = params.managedOpenCodeAdmission;
    if (grant?.outcome !== 'admitted') throw new Error('No managed admission');
    if (canonical(grant.input) !== canonical(expected)) {
      throw new Error('Accepted checkpoint was not passed to the next executor turn');
    }
    if (
      grant.attempt.input_task_id !== expected.attemptTaskId ||
      grant.attempt.input_store_id !== expected.storeId ||
      grant.attempt.input_read_closed_at !== null
    ) {
      throw new Error('Accepted checkpoint input was not pinned open');
    }
    const holder = grant.attempt.holder_instance_id;
    const state = params.client.service('opencode-native-state' as string) as unknown as {
      closeRead(input: unknown): Promise<void>;
      seal(input: unknown): Promise<void>;
    };
    await state.closeRead({
      task_id: params.taskId,
      holder_instance_id: holder,
      input: { storeId: expected.storeId, taskId: expected.attemptTaskId },
    });
    const manifest: ManagedOpenCodeNativeStateManifest = {
      ...expected,
      attemptTaskId: params.taskId,
      digest: `sha256:${'e'.repeat(64)}`,
      publishedAt: new Date().toISOString(),
    };
    await state.seal({ task_id: params.taskId, holder_instance_id: holder, manifest });
    const completed = await params.client.service('tasks').patch(params.taskId, {
      status: TaskStatus.COMPLETED,
      native_state_attempt: manifest,
      native_state_holder_instance_id: holder,
    } as never);
    if (completed.status !== TaskStatus.COMPLETED) throw new Error('Next turn did not complete');
    process.stdout.write('managed-resume-input-pinned\n');
  } catch (error) {
    process.stderr.write(
      `synthetic-provider-error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    throw error;
  }
};

await new AgorExecutor(config).start();
