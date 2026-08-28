import {
  createResourceMarker,
  RemoteBridgeError,
  sameIdentifier,
  sanitizeProviderOutput,
  validateRequest,
} from './bridge-contract.mjs';

export { createResourceMarker, RemoteBridgeError, sanitizeProviderOutput };

const ACTIVE_STATES = new Set(['Available', 'Starting', 'Queued', 'Rebuilding']);
const STOPPED_STATES = new Set(['Shutdown', 'Deleted']);
const TERMINAL_FAILURE_STATES = new Set(['Failed', 'Unavailable', 'Unknown']);
const DEFAULT_TIMEOUTS = Object.freeze({
  startMs: 10 * 60_000,
  stopMs: 3 * 60_000,
  pollMs: 5_000,
  providerCallMs: 30_000,
});

/**
 * A single-process lease used by the prototype and its tests. Production must
 * replace this with a durable tenant-scoped lease shared by all daemon replicas.
 */
export class InMemoryRemoteLease {
  #tails = new Map();

  async run(key, work) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

/**
 * Provider-neutral lifecycle core. The provider is deliberately injected so
 * tests cannot mutate a real account and a future Agor service can supply a
 * short-lived, owner-bound credential without putting it in command text.
 */
export class ManagedRemoteEnvironmentBridge {
  constructor({
    provider,
    accessValidator,
    lease = new InMemoryRemoteLease(),
    now = () => Date.now(),
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    timeouts = {},
  }) {
    if (!provider) {
      throw new RemoteBridgeError('INVALID_PROVIDER', 'A remote environment provider is required');
    }
    if (typeof accessValidator !== 'function') {
      throw new RemoteBridgeError(
        'INVALID_ACCESS_POLICY',
        'A provider-specific access URL validator is required'
      );
    }

    this.provider = provider;
    this.accessValidator = accessValidator;
    this.lease = lease;
    this.now = now;
    this.sleep = sleep;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  async execute(rawRequest) {
    const request = validateRequest(rawRequest);
    const marker = createResourceMarker(request.tenantId, request.branchId);
    const bindingKey = `${request.tenantId}:${request.branchId}`;

    return this.lease.run(bindingKey, async () => {
      const context = { request, marker, bindingKey };
      switch (request.action) {
        case 'start':
          return this.#start(context);
        case 'stop':
          return this.#stop(context);
        case 'health':
          return this.#health(context);
        case 'logs':
          return this.#logs(context);
        case 'nuke':
          return this.#nuke(context);
        default:
          throw new RemoteBridgeError('INVALID_ACTION', 'Unsupported lifecycle action');
      }
    });
  }

  async #start(context) {
    await this.#assertCurrent(context);
    const discovery = await this.#discover(context);
    let resource = discovery.resource;

    if (!resource) {
      await this.#assertCurrent(context);
      resource = await this.#providerCall('create', (signal) =>
        this.provider.create({
          repositoryId: discovery.repository.id,
          repository: discovery.repository.fullName,
          ref: context.request.ref,
          marker: context.marker,
          ...providerOperationContext(context),
          signal,
        })
      );
      this.#validateResource(resource, discovery, context);
    } else if (STOPPED_STATES.has(resource.state) && resource.state !== 'Deleted') {
      resource = await this.#reloadAndValidate(resource, discovery, context);
      await this.#assertCurrent(context);
      resource = await this.#providerCall('start', (signal) =>
        this.provider.start(resource.name, { ...providerOperationContext(context), signal })
      );
      this.#validateResource(resource, discovery, context);
    }

    resource = await this.#waitForState({
      resource,
      discovery,
      context,
      accepted: (state) => state === 'Available',
      timeoutMs: this.timeouts.startMs,
      timeoutCode: 'START_TIMEOUT',
    });
    await this.#assertCurrent(context);

    return this.#currentResult('running', resource, context);
  }

  async #stop(context) {
    await this.#assertCurrent(context);
    const discovery = await this.#discover(context);
    if (!discovery.resource) {
      return this.#currentResult('stopped', undefined, context, { alreadyAbsent: true });
    }

    let resource = await this.#reloadAndValidate(discovery.resource, discovery, context);
    if (!STOPPED_STATES.has(resource.state)) {
      await this.#assertCurrent(context);
      resource = await this.#providerCall('stop', (signal) =>
        this.provider.stop(resource.name, { ...providerOperationContext(context), signal })
      );
      this.#validateResource(resource, discovery, context);
      resource = await this.#waitForState({
        resource,
        discovery,
        context,
        accepted: (state) => state === 'Shutdown',
        timeoutMs: this.timeouts.stopMs,
        timeoutCode: 'STOP_TIMEOUT',
      });
    }

    await this.#assertCurrent(context);
    return this.#currentResult('stopped', resource, context);
  }

  async #health(context) {
    await this.#assertCurrent(context);
    const discovery = await this.#discover(context);
    if (!discovery.resource) {
      return this.#currentResult('absent', undefined, context, { healthy: false });
    }

    const resource = await this.#reloadAndValidate(discovery.resource, discovery, context);
    return this.#currentResult(
      resource.state === 'Available' ? 'running' : 'not_ready',
      resource,
      context,
      {
        healthy: resource.state === 'Available',
      }
    );
  }

  async #logs(context) {
    await this.#assertCurrent(context);
    const discovery = await this.#discover(context);
    if (!discovery.resource) {
      return this.#currentResult('absent', undefined, context, { logs: '' });
    }

    const resource = await this.#reloadAndValidate(discovery.resource, discovery, context);
    const rawLogs = await this.#providerCall('logs', (signal) =>
      this.provider.logs(resource.name, { ...providerOperationContext(context), signal })
    );
    return this.#currentResult('available', resource, context, {
      logs: sanitizeProviderOutput(rawLogs),
      logKind: 'provider_creation',
    });
  }

  async #nuke(context) {
    await this.#assertCurrent(context);
    const discovery = await this.#discover(context);
    if (!discovery.resource) {
      return this.#currentResult('deleted', undefined, context, { alreadyAbsent: true });
    }

    const resource = await this.#reloadAndValidate(discovery.resource, discovery, context);
    await this.#assertCurrent(context);
    await this.#providerCall('delete', (signal) =>
      this.provider.delete(resource.name, { ...providerOperationContext(context), signal })
    );
    await this.#assertCurrent(context);
    return this.#currentResult('deleted', undefined, context, {
      deletedResourceName: resource.name,
    });
  }

  async #discover(context) {
    const [viewer, repository] = await Promise.all([
      this.#providerCall('viewer', (signal) => this.provider.viewer({ signal })),
      this.#providerCall('repository', (signal) =>
        this.provider.repository(context.request.repository, { signal })
      ),
    ]);

    if (!sameIdentifier(viewer.login, context.request.credentialOwnerLogin)) {
      throw new RemoteBridgeError(
        'CREDENTIAL_OWNER_MISMATCH',
        'The provider credential does not belong to the expected resource owner'
      );
    }
    if (!sameIdentifier(repository.fullName, context.request.repository)) {
      throw new RemoteBridgeError(
        'REPOSITORY_MISMATCH',
        'The provider resolved a different repository than the trusted request'
      );
    }
    if (
      context.request.providerRepositoryId !== undefined &&
      String(repository.id) !== context.request.providerRepositoryId
    ) {
      throw new RemoteBridgeError(
        'REPOSITORY_ID_MISMATCH',
        'The provider repository identifier differs from the persisted binding'
      );
    }

    const resources = await this.#providerCall('list', (signal) =>
      this.provider.list({ repositoryId: repository.id, signal })
    );
    if (!Array.isArray(resources)) {
      throw new RemoteBridgeError(
        'INVALID_PROVIDER_RESPONSE',
        'The provider returned an invalid list'
      );
    }
    const candidates = resources.filter(
      (resource) => resource.marker === context.marker && resource.state !== 'Deleted'
    );
    if (candidates.length > 1) {
      throw new RemoteBridgeError(
        'AMBIGUOUS_RESOURCE',
        'Multiple provider resources claim this Agor environment binding'
      );
    }

    if (candidates.length === 0 && context.request.lastKnownResourceName) {
      const lastKnown = resources.find(
        (resource) => resource.name === context.request.lastKnownResourceName
      );
      if (lastKnown && lastKnown.state !== 'Deleted') {
        candidates.push(lastKnown);
      }
    }

    const discovery = { viewer, repository, resource: candidates[0] };
    if (discovery.resource) {
      this.#validateResource(discovery.resource, discovery, context);
    }
    return discovery;
  }

  async #reloadAndValidate(resource, discovery, context) {
    const current = await this.#providerCall('get', (signal) =>
      this.provider.get(resource.name, { signal })
    );
    this.#validateResource(current, discovery, context);
    return current;
  }

  #validateResource(resource, discovery, context) {
    if (!resource || typeof resource !== 'object') {
      throw new RemoteBridgeError('INVALID_RESOURCE', 'The provider returned an invalid resource');
    }
    if (resource.marker !== context.marker) {
      throw new RemoteBridgeError(
        'RESOURCE_MARKER_MISMATCH',
        'The provider resource is not bound to this Agor environment'
      );
    }
    if (!sameIdentifier(resource.ownerLogin, discovery.viewer.login)) {
      throw new RemoteBridgeError(
        'RESOURCE_OWNER_MISMATCH',
        'The provider resource has a different owner than the bound credential'
      );
    }
    if (String(resource.repositoryId) !== String(discovery.repository.id)) {
      throw new RemoteBridgeError(
        'RESOURCE_REPOSITORY_MISMATCH',
        'The provider resource belongs to a different repository'
      );
    }
    if (!sameIdentifier(resource.repository, discovery.repository.fullName)) {
      throw new RemoteBridgeError(
        'RESOURCE_REPOSITORY_MISMATCH',
        'The provider resource repository name does not match its binding'
      );
    }
    if (resource.ref !== context.request.ref) {
      throw new RemoteBridgeError(
        'RESOURCE_REF_MISMATCH',
        'The provider resource is no longer on the bound repository ref'
      );
    }
    if (typeof resource.name !== 'string' || resource.name.length === 0) {
      throw new RemoteBridgeError('INVALID_RESOURCE', 'The provider resource has no stable name');
    }
  }

  async #waitForState({ resource, discovery, context, accepted, timeoutMs, timeoutCode }) {
    const deadline = this.now() + timeoutMs;
    let current = resource;

    while (!accepted(current.state)) {
      if (TERMINAL_FAILURE_STATES.has(current.state)) {
        throw new RemoteBridgeError(
          'PROVIDER_TERMINAL_STATE',
          'The provider resource entered a terminal failure state'
        );
      }
      if (!ACTIVE_STATES.has(current.state) && !STOPPED_STATES.has(current.state)) {
        throw new RemoteBridgeError(
          'UNSUPPORTED_PROVIDER_STATE',
          'The provider returned an unsupported lifecycle state'
        );
      }
      if (this.now() >= deadline) {
        throw new RemoteBridgeError(timeoutCode, 'The provider lifecycle operation timed out');
      }

      await this.sleep(Math.min(this.timeouts.pollMs, Math.max(0, deadline - this.now())));
      await this.#assertCurrent(context);
      current = await this.#reloadAndValidate(current, discovery, context);
    }

    return current;
  }

  async #result(status, resource, context, extra = {}) {
    let access = {};
    if (resource && this.provider.access) {
      access = this.accessValidator(
        await this.#providerCall('access', (signal) =>
          this.provider.access(resource.name, { signal })
        )
      );
    }

    return {
      status,
      binding: {
        key: context.bindingKey,
        marker: context.marker,
        generation: context.request.generation,
        providerRepositoryId: resource?.repositoryId,
        resourceName: resource?.name,
      },
      resource: resource
        ? {
            name: resource.name,
            state: resource.state,
            editorUrl: access.editorUrl,
          }
        : undefined,
      accessUrls: access.accessUrls ?? [],
      ...extra,
    };
  }

  async #currentResult(status, resource, context, extra = {}) {
    const result = await this.#result(status, resource, context, extra);
    await this.#assertCurrent(context);
    return result;
  }

  async #assertCurrent(context) {
    const current = await context.request.isAttemptCurrent({
      tenantId: context.request.tenantId,
      branchId: context.request.branchId,
      generation: context.request.generation,
      operationId: context.request.operationId,
    });
    if (!current) {
      throw new RemoteBridgeError(
        'STALE_ATTEMPT',
        'The lifecycle attempt is no longer current and will not mutate or publish state'
      );
    }
  }

  async #providerCall(operation, work) {
    const controller = new AbortController();
    const timeoutSentinel = Object.freeze({});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutSentinel);
      }, this.timeouts.providerCallMs);
    });

    try {
      return await Promise.race([work(controller.signal), timeout]);
    } catch (error) {
      if (error === timeoutSentinel) {
        throw new RemoteBridgeError(
          'PROVIDER_TIMEOUT',
          `The provider ${operation} request timed out`
        );
      }
      throw new RemoteBridgeError(
        'PROVIDER_REQUEST_FAILED',
        `The provider ${operation} request failed`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerOperationContext(context) {
  return {
    tenantId: context.request.tenantId,
    branchId: context.request.branchId,
    actorUserId: context.request.actorUserId,
    credentialOwnerUserId: context.request.credentialOwnerUserId,
    generation: context.request.generation,
    operationId: context.request.operationId,
  };
}
