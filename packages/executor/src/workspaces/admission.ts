/** Local admission is keyed by tenant AND branch. The version includes every accepted
 * reader/dispatch, even if it never commits source (private homes and dependencies matter). */
export class BranchAdmission {
  private states = new Map<
    string,
    { active: number; locked: boolean; version: number; waiters: Set<() => void> }
  >();
  private state(tenant: string, branch: string) {
    const key = JSON.stringify([tenant, branch]);
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, locked: false, version: 0, waiters: new Set() };
      this.states.set(key, state);
    }
    return state;
  }
  enter(tenant: string, branch: string): (() => void) | undefined {
    const state = this.state(tenant, branch);
    if (state.locked) return;
    state.active++;
    state.version++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        state.active--;
      }
    };
  }
  async enterWhenReady(tenant: string, branch: string, signal: AbortSignal): Promise<() => void> {
    const state = this.state(tenant, branch);
    for (;;) {
      signal.throwIfAborted();
      const leave = this.enter(tenant, branch);
      if (leave) return leave;
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          state.waiters.delete(wake);
          signal.removeEventListener('abort', abort);
        };
        const wake = () => {
          clean();
          resolve();
        };
        const abort = () => {
          clean();
          reject(signal.reason);
        };
        state.waiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  lock(tenant: string, branch: string): (() => void) | undefined {
    const state = this.state(tenant, branch);
    if (state.locked || state.active) return;
    state.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.locked = false;
      for (const wake of [...state.waiters]) wake();
    };
  }
  version(tenant: string, branch: string) {
    return this.state(tenant, branch).version;
  }
}
