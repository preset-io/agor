import { spawn } from 'node:child_process';
import type { AgorConfig } from '@agor/core/config';
import {
  and,
  eq,
  generateId,
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  opencodeCheckpointAttempts,
  select,
  sessions,
  TaskRepository,
  type TaskRuntimeAuthorityScope,
  type TenantScopeAwareDatabase,
  tasks,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden, TooManyRequests } from '@agor/core/feathers';
import type { Params } from '@agor/core/types';
import {
  isOpenCodeCheckpointLaunchLocator,
  OPENCODE_OBSERVER_BUSY_REASON,
  type OpenCodeCheckpointAdmission,
  type OpenCodeCheckpointBeginInput,
  type OpenCodeCheckpointBinding,
  type OpenCodeCheckpointCleanupWork,
  type OpenCodeCheckpointCloseReadInput,
  type OpenCodeCheckpointDeleteResult,
  type OpenCodeCheckpointHolderInput,
  type OpenCodeCheckpointLocator,
  type OpenCodeCheckpointSealInput,
  type OpenCodeNativeStateAttempt,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { authenticatedTaskExecutorRuntimeAuthority } from '../auth/executor-runtime-scope.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';
import { buildTrustedLauncherEnvironment } from '../utils/trusted-launcher-environment.js';
import type { TaskExecutorCredentialRevoker } from './tasks.js';

const MAX_HELPER_OUTPUT_BYTES = 32 * 1024;
const NATIVE_STATE_HOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CONTAINER_ID = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[A-Za-z0-9._:-]{1,220}$/;
const SAFE_IMAGE_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,1023}@)?sha256:[0-9a-f]{64}$/;

/** A committed same-holder begin must replay its immutable store binding. */
export function selectManagedOpenCodeAdmissionStoreId(
  existingStoreId: string | undefined,
  storedId: unknown,
  pointerStoreId: unknown
): string {
  if (existingStoreId) return existingStoreId;
  if (typeof storedId === 'string') return storedId;
  if (typeof pointerStoreId === 'string') return pointerStoreId;
  return generateId();
}
interface OpenCodeCheckpointRepository {
  begin(input: {
    taskId: string;
    holderInstanceId: string;
    binding: OpenCodeCheckpointBinding;
    storeId?: string;
    authority?: TaskRuntimeAuthorityScope;
    assertRuntimeAuthority?: (
      tx: TenantScopeAwareDatabase,
      taskId: string,
      authority: TaskRuntimeAuthorityScope,
      allowStoppingReplay: boolean
    ) => Promise<void>;
  }): Promise<OpenCodeCheckpointAdmission>;
  closeRead(
    taskId: string,
    holderId: string,
    input: { storeId: string; taskId: string }
  ): Promise<void>;
  seal(taskId: string, holderId: string, manifest: OpenCodeNativeStateAttempt): Promise<void>;
  abandon(taskId: string, holderId: string): Promise<void>;
  prepareCleanup(taskId: string, holderId: string): Promise<OpenCodeCheckpointCleanupWork>;
  loadObservationBinding(
    taskId: string,
    holderId: string,
    attemptId: string
  ): Promise<OpenCodeCheckpointBinding>;
  recordHolderObservation(
    currentTaskId: string,
    currentHolderId: string,
    attemptId: string,
    outcome: 'verified_closed' | 'still_present' | 'unknown',
    errorCode?: string
  ): Promise<void>;
  acknowledgeDelete(
    taskId: string,
    holderId: string,
    object: { storeId: string; taskId: string },
    result: OpenCodeCheckpointDeleteResult
  ): Promise<void>;
}

async function newCheckpointRepository(
  db: TenantScopeAwareDatabase
): Promise<OpenCodeCheckpointRepository> {
  const core = (await import('@agor/core/db')) as unknown as {
    OpenCodeCheckpointAttemptRepository: new (
      database: TenantScopeAwareDatabase
    ) => OpenCodeCheckpointRepository;
  };
  return new core.OpenCodeCheckpointAttemptRepository(db);
}

function isV3Manifest(value: unknown): value is OpenCodeNativeStateAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 3 &&
    Object.keys(candidate).length === 8 &&
    typeof candidate.storeId === 'string' &&
    NATIVE_STATE_HOLDER.test(candidate.storeId) &&
    typeof candidate.attemptTaskId === 'string' &&
    NATIVE_STATE_HOLDER.test(candidate.attemptTaskId) &&
    typeof candidate.digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(candidate.digest) &&
    typeof candidate.bytes === 'number' &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.openCodeSessionId === 'string' &&
    candidate.openCodeSessionId.length > 0 &&
    candidate.openCodeSessionId.length <= 200 &&
    typeof candidate.openCodeVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(candidate.openCodeVersion) &&
    typeof candidate.publishedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.publishedAt))
  );
}

type ObserverRequest =
  | {
      version: 1;
      action: 'resolve';
      expected: Record<string, string>;
      locator: OpenCodeCheckpointBeginInput['locator'];
    }
  | { version: 1; action: 'observe'; binding: OpenCodeCheckpointBinding };

type ObserverResponse =
  | { version: 1; action: 'resolve'; locator: OpenCodeCheckpointLocator }
  | { version: 1; action: 'observe'; outcome: 'verified_closed' | 'still_present' | 'unknown' };

// Task tokens are bearer credentials inside a hosted Job. One token must not be
// able to fork an unbounded number of trusted Cloud helpers on a shared daemon.
const MAX_ACTIVE_OBSERVER_HELPERS = 16;
const MAX_ACTIVE_OBSERVER_HELPERS_PER_TENANT = 4;
const MAX_ACTIVE_OBSERVATIONS = 4;
const OBSERVER_TASK_COOLDOWN_MS = 1_000;
const observerSlots = new Map<string, { active: boolean; retryAt: number }>();
let activeObserverHelpers = 0;
let activeObservations = 0;
const activeHelpersByTenant = new Map<string, number>();
class ObserverCapacityError extends TooManyRequests {
  constructor() {
    super('Trusted Cloud observer helper is busy; retry later', {
      reason: OPENCODE_OBSERVER_BUSY_REASON,
    });
  }
}

export async function withOpenCodeObserverSlot<T>(
  tenantId: string,
  taskId: string,
  action: 'resolve' | 'observe',
  work: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([tenantId, taskId]);
  const now = Date.now();
  const current = observerSlots.get(key);
  if (
    current?.active ||
    (current && current.retryAt > now) ||
    activeObserverHelpers >= MAX_ACTIVE_OBSERVER_HELPERS ||
    (activeHelpersByTenant.get(tenantId) ?? 0) >= MAX_ACTIVE_OBSERVER_HELPERS_PER_TENANT ||
    (action === 'observe' && activeObservations >= MAX_ACTIVE_OBSERVATIONS)
  ) {
    throw new ObserverCapacityError();
  }
  if (observerSlots.size > 1_024) {
    for (const [candidate, slot] of observerSlots) {
      if (!slot.active && slot.retryAt <= now) observerSlots.delete(candidate);
    }
  }
  observerSlots.set(key, { active: true, retryAt: now });
  activeObserverHelpers += 1;
  activeHelpersByTenant.set(tenantId, (activeHelpersByTenant.get(tenantId) ?? 0) + 1);
  if (action === 'observe') activeObservations += 1;
  try {
    return await work();
  } finally {
    activeObserverHelpers -= 1;
    const tenantActive = (activeHelpersByTenant.get(tenantId) ?? 1) - 1;
    if (tenantActive === 0) activeHelpersByTenant.delete(tenantId);
    else activeHelpersByTenant.set(tenantId, tenantActive);
    if (action === 'observe') activeObservations -= 1;
    observerSlots.set(key, { active: false, retryAt: Date.now() + OBSERVER_TASK_COOLDOWN_MS });
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseResolvedLocator(value: unknown): OpenCodeCheckpointLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Conflict('Trusted Cloud identity resolution failed');
  const candidate = value as Record<string, unknown>;
  const keys = [
    'runId',
    'cellId',
    'tenantId',
    'ownerRuntimeUserId',
    'sessionId',
    'taskId',
    'storeId',
    'holderInstanceId',
    'namespace',
    'jobName',
    'jobUid',
    'podName',
    'podUid',
    'containerName',
    'containerId',
    'restartCount',
    'imageIdentity',
  ];
  if (
    !exactKeys(candidate, keys) ||
    !keys
      .filter(
        (key) =>
          key !== 'containerName' &&
          key !== 'restartCount' &&
          key !== 'imageIdentity' &&
          key !== 'containerId'
      )
      .every(
        (key) => typeof candidate[key] === 'string' && SAFE_CLOUD_ID.test(candidate[key] as string)
      ) ||
    candidate.containerName !== 'executor' ||
    candidate.restartCount !== 0 ||
    typeof candidate.containerId !== 'string' ||
    !SAFE_CONTAINER_ID.test(candidate.containerId) ||
    typeof candidate.imageIdentity !== 'string' ||
    !SAFE_IMAGE_ID.test(candidate.imageIdentity)
  ) {
    throw new Conflict('Trusted Cloud identity resolution returned an invalid container binding');
  }
  return candidate as unknown as OpenCodeCheckpointLocator;
}

async function runObserver(
  config: AgorConfig,
  request: ObserverRequest
): Promise<ObserverResponse> {
  const settings = (
    config.execution as
      | (AgorConfig['execution'] & {
          opencode_native_state_observer?: { command_template?: string; timeout_ms?: number };
        })
      | undefined
  )?.opencode_native_state_observer;
  const command = settings?.command_template?.trim();
  if (!command)
    throw new Conflict('Managed OpenCode admission requires the trusted Cloud observer helper');
  const timeoutMs = settings?.timeout_ms ?? 2_000;
  const identity = request.action === 'resolve' ? request.expected : request.binding;
  return withOpenCodeObserverSlot(identity.tenantId, identity.taskId, request.action, () =>
    runObserverProcess(command, timeoutMs, request)
  );
}

export function runObserverProcess(
  command: string,
  timeoutMs: number,
  request: ObserverRequest
): Promise<ObserverResponse> {
  return new Promise<ObserverResponse>((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      env: buildTrustedLauncherEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: ObserverResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // A command wrapper may leave a descendant holding stdout open, so
        // `close` is not guaranteed even after the shell is killed. Refuse the
        // request at the deadline rather than hanging admission indefinitely.
        finish(new Conflict('Trusted Cloud observer helper timed out'));
      }, 250);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Conflict('Trusted Cloud observer response exceeded its bounded size'));
      }
    });
    child.on('error', () => finish(new Conflict('Trusted Cloud observer helper could not start')));
    // `exit` may precede the last stdout chunk; `close` follows stream closure.
    child.on('close', (code) => {
      if (timedOut) return finish(new Conflict('Trusted Cloud observer helper timed out'));
      if (code !== 0)
        return finish(new Conflict('Trusted Cloud observer helper rejected the request'));
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish(new Conflict('Trusted Cloud observer returned invalid JSON'));
        }
        const response = parsed as Record<string, unknown>;
        if (response.version !== 1 || !['resolve', 'observe'].includes(String(response.action))) {
          return finish(new Conflict('Trusted Cloud observer returned an unsupported response'));
        }
        if (response.action === 'resolve') {
          if (!exactKeys(response, ['version', 'action', 'locator'])) {
            return finish(new Conflict('Trusted Cloud identity response has unexpected fields'));
          }
          finish(undefined, {
            version: 1,
            action: 'resolve',
            locator: parseResolvedLocator(response.locator),
          });
          return;
        }
        if (
          !exactKeys(response, ['version', 'action', 'outcome']) ||
          !['verified_closed', 'still_present', 'unknown'].includes(String(response.outcome))
        ) {
          return finish(new Conflict('Trusted Cloud observation response is malformed'));
        }
        finish(undefined, {
          version: 1,
          action: 'observe',
          outcome: response.outcome as 'verified_closed' | 'still_present' | 'unknown',
        });
      } catch {
        finish(new Conflict('Trusted Cloud observer returned invalid JSON'));
      }
    });
    child.stdin?.on('error', () =>
      finish(new Conflict('Trusted Cloud observer request could not be delivered'))
    );
    child.stdin?.end(`${JSON.stringify(request)}\n`);
  });
}

export interface OpenCodeNativeStateServiceOptions {
  db: TenantScopeAwareDatabase;
  getConfig: () => AgorConfig;
  executorCredentialRevoker?: TaskExecutorCredentialRevoker;
}

/** Holder-authenticated, DB-only state transitions plus one narrow trusted Cloud identity helper. */
export class OpenCodeNativeStateService {
  constructor(private readonly options: OpenCodeNativeStateServiceOptions) {}

  /**
   * The Express adapter recognizes an object as a Feathers service only when
   * it has at least one built-in method. This marker is intentionally omitted
   * from the transport allowlist; native-state authority is exposed only via
   * the explicit task-scoped methods registered in register-services.ts.
   */
  async get(): Promise<never> {
    throw new BadRequest('OpenCode native-state reads are not exposed');
  }

  private authority(taskId: string, params?: Params) {
    const authority = authenticatedTaskExecutorRuntimeAuthority(params);
    if (!authority || authority.taskId !== taskId) {
      throw new Forbidden('A token scoped to this executor task is required');
    }
    if (getCurrentTenantId() !== authority.tenantId) {
      throw new Forbidden('OpenCode checkpoint tenant does not match executor authority');
    }
    return authority;
  }

  private async repository<T>(
    tenantId: string,
    work: (repo: OpenCodeCheckpointRepository) => Promise<T>
  ): Promise<T> {
    return withFreshTenantWrite(this.options.db, tenantId, async () =>
      work(await newCheckpointRepository(this.options.db))
    );
  }

  async begin(
    input: OpenCodeCheckpointBeginInput,
    params?: Params
  ): Promise<OpenCodeCheckpointAdmission> {
    const authority = this.authority(input.task_id, params);
    if (
      !isOpenCodeCheckpointLaunchLocator(input.locator) ||
      !NATIVE_STATE_HOLDER.test(input.holder_instance_id)
    ) {
      throw new BadRequest('Managed OpenCode launch identity is missing or malformed');
    }
    const tenantId = authority.tenantId;
    const taskAuthority: TaskRuntimeAuthorityScope = {
      token_fingerprint: authority.tokenFingerprint,
      principal_user_id: authority.userId,
      session_id: authority.sessionId,
      branch_id: authority.branchId,
    };
    const assertRuntimeAuthority = async (
      tx: TenantScopeAwareDatabase,
      taskId: string,
      scoped: TaskRuntimeAuthorityScope,
      allowStoppingReplay: boolean
    ) => {
      const exact = { ...scoped };
      if (!isPostgresDatabaseHandle(tx)) {
        const check = this.options.executorCredentialRevoker?.isTaskTokenAuthorityCurrent;
        if (!check) throw new Forbidden('Executor task token authority is unavailable');
        exact.standalone_token_current = await check.call(this.options.executorCredentialRevoker, {
          tenantId,
          tokenFingerprint: authority.tokenFingerprint,
          sessionId: authority.sessionId,
          taskId: authority.taskId,
          branchId: authority.branchId,
          userId: authority.userId,
        });
      }
      const taskRepo = new TaskRepository(tx) as TaskRepository & {
        assertRuntimeCredentialAuthority(
          id: TaskID,
          authority: TaskRuntimeAuthorityScope,
          allowStoppingReplay?: boolean
        ): Promise<void>;
      };
      await taskRepo.assertRuntimeCredentialAuthority(taskId as TaskID, exact, allowStoppingReplay);
    };
    const snapshot = await withFreshTenantWrite(this.options.db, tenantId, async () => {
      const session = await select(this.options.db, {
        session_id: sessions.session_id,
        created_by: sessions.created_by,
        agentic_tool: sessions.agentic_tool,
        sdk_home_scope: sessions.sdk_home_scope,
        data: sessions.data,
      })
        .from(sessions)
        .where(eq(sessions.session_id, authority.sessionId))
        .one();
      if (
        session?.agentic_tool !== 'opencode' ||
        session.sdk_home_scope !== 'execution_home' ||
        session.created_by !== authority.userId
      ) {
        throw new Forbidden('Managed OpenCode requires the owner execution-home Session');
      }
      // Fast fail before any process spawn. The repository repeats these checks
      // under Session → Task locks after resolution; this read only bounds cost
      // for stale or invented holder calls carrying an otherwise valid task token.
      const task = await select(this.options.db)
        .from(tasks)
        .where(eq(tasks.task_id, input.task_id))
        .one();
      const existing = await select(this.options.db, {
        holder_instance_id: opencodeCheckpointAttempts.holder_instance_id,
        store_id: opencodeCheckpointAttempts.store_id,
        binding: opencodeCheckpointAttempts.binding,
      })
        .from(opencodeCheckpointAttempts)
        .where(
          and(
            eq(opencodeCheckpointAttempts.tenant_id, tenantId),
            eq(opencodeCheckpointAttempts.session_id, session.session_id),
            eq(opencodeCheckpointAttempts.task_id, input.task_id)
          )
        )
        .one();
      if (existing && existing.holder_instance_id !== input.holder_instance_id) {
        throw new Conflict('Managed OpenCode Task already has a different checkpoint holder');
      }
      const active =
        task?.status === TaskStatus.RUNNING ||
        task?.status === TaskStatus.AWAITING_INPUT ||
        task?.status === TaskStatus.AWAITING_PERMISSION;
      if (
        !task ||
        task.session_id !== session.session_id ||
        task.created_by !== authority.userId ||
        task.data.managed_opencode_protocol !== 3 ||
        !task.executor_connected_at ||
        (!active && !(task.status === TaskStatus.STOPPING && existing))
      ) {
        throw new Conflict('Managed OpenCode Task is not active for checkpoint admission');
      }
      const pointer = session.data.sdk_native_state;
      const storedId = session.data.sdk_native_state_store_id;
      const pointerStoreId =
        pointer && typeof pointer === 'object' && 'storeId' in pointer
          ? (pointer as { storeId?: unknown }).storeId
          : undefined;
      // A retry after a committed begin but lost response must reuse the
      // original binding, including its store. Otherwise the same holder is
      // falsely rejected and cannot recover its admitted attempt.
      const storeId = selectManagedOpenCodeAdmissionStoreId(
        existing?.store_id,
        storedId,
        pointerStoreId
      );
      return { sessionId: session.session_id, ownerUserId: session.created_by, storeId, existing };
    });

    if (snapshot.existing) {
      // This grant was already bound by a trusted observer. A lost response can
      // be replayed without another Pod read, including after Stop. The ledger
      // transaction below accepts only the original open exact-holder binding.
      const binding = snapshot.existing.binding;
      const locator = binding.locator;
      if (
        binding.protocol !== 3 ||
        binding.tenantId !== tenantId ||
        binding.ownerUserId !== snapshot.ownerUserId ||
        binding.sessionId !== snapshot.sessionId ||
        binding.taskId !== input.task_id ||
        binding.storeId !== snapshot.storeId ||
        binding.holderInstanceId !== input.holder_instance_id ||
        locator.runId !== input.locator.runId ||
        locator.cellId !== input.locator.cellId ||
        locator.namespace !== input.locator.namespace ||
        locator.podName !== input.locator.podName ||
        locator.podUid !== input.locator.podUid ||
        locator.containerName !== input.locator.containerName
      )
        throw new Conflict('Managed OpenCode retry does not match the admitted binding');
      return this.repository(tenantId, (repo) =>
        repo.begin({
          taskId: input.task_id,
          holderInstanceId: input.holder_instance_id,
          binding,
          storeId: snapshot.storeId,
          authority: taskAuthority,
          assertRuntimeAuthority,
        })
      );
    }

    // This external resolution is not admission. The subsequent DB transaction
    // rechecks all current state after the helper returns.
    const helper = await runObserver(this.options.getConfig(), {
      version: 1,
      action: 'resolve',
      expected: {
        tenantId,
        ownerUserId: snapshot.ownerUserId,
        sessionId: snapshot.sessionId,
        taskId: input.task_id,
        storeId: snapshot.storeId,
        holderInstanceId: input.holder_instance_id,
      },
      locator: input.locator,
    });
    if (helper?.version !== 1 || helper.action !== 'resolve') {
      throw new Conflict('Trusted Cloud identity resolution did not return a binding');
    }
    const locator = parseResolvedLocator(helper.locator);
    if (
      locator.runId !== input.locator.runId ||
      locator.cellId !== input.locator.cellId ||
      locator.tenantId !== tenantId ||
      locator.ownerRuntimeUserId !== snapshot.ownerUserId ||
      locator.sessionId !== snapshot.sessionId ||
      locator.taskId !== input.task_id ||
      locator.storeId !== snapshot.storeId ||
      locator.holderInstanceId !== input.holder_instance_id ||
      locator.namespace !== input.locator.namespace ||
      locator.podName !== input.locator.podName ||
      locator.podUid !== input.locator.podUid ||
      locator.containerName !== input.locator.containerName
    ) {
      throw new Conflict('Trusted Cloud identity does not match the authenticated OpenCode Task');
    }

    const binding: OpenCodeCheckpointBinding = {
      protocol: 3,
      tenantId,
      ownerUserId: snapshot.ownerUserId,
      sessionId: snapshot.sessionId,
      taskId: input.task_id,
      storeId: snapshot.storeId,
      holderInstanceId: input.holder_instance_id,
      locator,
    };
    return this.repository(tenantId, (repo) =>
      repo.begin({
        taskId: input.task_id,
        holderInstanceId: input.holder_instance_id,
        binding,
        storeId: snapshot.storeId,
        authority: taskAuthority,
        assertRuntimeAuthority,
      })
    );
  }

  async closeRead(input: OpenCodeCheckpointCloseReadInput, params?: Params): Promise<void> {
    const authority = this.authority(input.task_id, params);
    if (
      !NATIVE_STATE_HOLDER.test(input.holder_instance_id) ||
      !NATIVE_STATE_HOLDER.test(input.input?.storeId ?? '') ||
      !NATIVE_STATE_HOLDER.test(input.input?.taskId ?? '')
    )
      throw new BadRequest('OpenCode read-close identity is malformed');
    await this.repository(authority.tenantId, (repo) =>
      repo.closeRead(input.task_id, input.holder_instance_id, input.input)
    );
  }

  async seal(input: OpenCodeCheckpointSealInput, params?: Params): Promise<void> {
    const authority = this.authority(input.task_id, params);
    if (!NATIVE_STATE_HOLDER.test(input.holder_instance_id) || !isV3Manifest(input.manifest))
      throw new BadRequest('OpenCode seal is malformed');
    await this.repository(authority.tenantId, (repo) =>
      repo.seal(input.task_id, input.holder_instance_id, input.manifest)
    );
  }

  async abandon(input: OpenCodeCheckpointHolderInput, params?: Params): Promise<void> {
    const authority = this.authority(input.task_id, params);
    if (!NATIVE_STATE_HOLDER.test(input.holder_instance_id))
      throw new BadRequest('OpenCode holder identity is malformed');
    await this.repository(authority.tenantId, (repo) =>
      repo.abandon(input.task_id, input.holder_instance_id)
    );
  }

  async prepareCleanup(
    input: OpenCodeCheckpointHolderInput,
    params?: Params
  ): Promise<OpenCodeCheckpointCleanupWork> {
    const authority = this.authority(input.task_id, params);
    if (!NATIVE_STATE_HOLDER.test(input.holder_instance_id))
      throw new BadRequest('OpenCode holder identity is malformed');
    return this.repository(authority.tenantId, (repo) =>
      repo.prepareCleanup(input.task_id, input.holder_instance_id)
    );
  }

  async observe(
    input: OpenCodeCheckpointHolderInput & { attempt_id: string },
    params?: Params
  ): Promise<void> {
    const authority = this.authority(input.task_id, params);
    if (
      !NATIVE_STATE_HOLDER.test(input.holder_instance_id) ||
      !NATIVE_STATE_HOLDER.test(input.attempt_id)
    ) {
      throw new BadRequest('OpenCode observation identity is malformed');
    }
    // Read the immutable locator under tenant scope, then release the DB transaction
    // before the external helper call. Re-enter a short transaction only to record
    // the result; never hold DB locks across Cloud/Kubernetes latency.
    const binding = await this.repository(authority.tenantId, (repo) =>
      repo.loadObservationBinding(input.task_id, input.holder_instance_id, input.attempt_id)
    );
    let outcome: 'verified_closed' | 'still_present' | 'unknown';
    let errorCode: string | undefined;
    try {
      const response = await runObserver(this.options.getConfig(), {
        version: 1,
        action: 'observe',
        binding,
      });
      if (response.action !== 'observe')
        throw new Conflict('Trusted Cloud observer returned an unexpected action');
      outcome = response.outcome;
      if (outcome === 'unknown') errorCode = 'CLOUD_UNKNOWN';
    } catch (error) {
      if (error instanceof ObserverCapacityError) throw error;
      outcome = 'unknown';
      errorCode = 'HELPER_UNAVAILABLE';
    }
    await this.repository(authority.tenantId, (repo) =>
      repo.recordHolderObservation(
        input.task_id,
        input.holder_instance_id,
        input.attempt_id,
        outcome,
        errorCode
      )
    );
  }

  async acknowledgeDelete(
    input: OpenCodeCheckpointHolderInput & {
      object: { storeId: string; taskId: string };
      result: { outcome: 'deleted' } | { outcome: 'failed'; errorCode: string };
    },
    params?: Params
  ): Promise<void> {
    const authority = this.authority(input.task_id, params);
    if (
      !NATIVE_STATE_HOLDER.test(input.holder_instance_id) ||
      !NATIVE_STATE_HOLDER.test(input.object?.storeId ?? '') ||
      !NATIVE_STATE_HOLDER.test(input.object?.taskId ?? '') ||
      !input.result ||
      !['deleted', 'failed'].includes(input.result.outcome)
    ) {
      throw new BadRequest('OpenCode deletion acknowledgement is malformed');
    }
    const result: OpenCodeCheckpointDeleteResult =
      input.result.outcome === 'deleted'
        ? { outcome: 'deleted' }
        : {
            outcome: 'failed',
            errorCode: /^[A-Z0-9_]{1,96}$/.test(input.result.errorCode)
              ? input.result.errorCode
              : 'DELETE_FAILED',
          };
    await this.repository(authority.tenantId, (repo) =>
      repo.acknowledgeDelete(input.task_id, input.holder_instance_id, input.object, result)
    );
  }
}
