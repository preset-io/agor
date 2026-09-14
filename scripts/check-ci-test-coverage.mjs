#!/usr/bin/env node

// Loading the matrix performs the invariant checks and exits non-zero if a
// workspace test script is missing from CI.  Keep this as a separate command
// so it runs before any expensive lane and gives a focused failure message.
await import('./ci-test-matrix.mjs');
