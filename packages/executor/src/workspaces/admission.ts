/** Local admission is keyed by tenant AND branch. The version includes every accepted
 * reader/dispatch, even if it never commits source (private homes and dependencies matter). */
export class BranchAdmission {
  private states = new Map<string, { active: number; locked: boolean; version: number }>();
  private state(tenant: string, branch: string) {
    const key = JSON.stringify([tenant, branch]);
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, locked: false, version: 0 };
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
  lock(tenant: string, branch: string): (() => void) | undefined {
    const state = this.state(tenant, branch);
    if (state.locked || state.active) return;
    state.locked = true;
    return () => {
      state.locked = false;
    };
  }
  version(tenant: string, branch: string) {
    return this.state(tenant, branch).version;
  }
}
