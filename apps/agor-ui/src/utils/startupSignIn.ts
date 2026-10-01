/**
 * Orders the two network bursts of a cold load: the startup sign-in request
 * first, then the workspace's code chunks.
 *
 * Over HTTP/1.1 a browser opens at most six connections per origin. The
 * workspace route preload asks for dozens of chunks at once, and a sign-in
 * request issued a moment later waits behind all of them. On a VPN that was
 * 1.5 s (3.3 s on a harsher link), and the socket, and therefore every data
 * read, waits on sign-in. Letting sign-in go first costs the chunks one
 * macrotask.
 */

let markDispatched: () => void = () => {};
const dispatched = new Promise<void>((resolve) => {
  markDispatched = resolve;
});

/** Called by the startup sign-in once its request is about to be sent. */
export function markStartupSignInDispatched(): void {
  markDispatched();
}

/**
 * Resolves after the startup sign-in request has been queued, or after
 * `maxWaitMs` if it never is (so chunk loading can't stall behind a stuck
 * sign-in), and then one macrotask later so the request's own microtasks run
 * first.
 */
export function afterStartupSignInDispatched(maxWaitMs = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  return Promise.race([dispatched, cap])
    .then(() => clearTimeout(timer))
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
