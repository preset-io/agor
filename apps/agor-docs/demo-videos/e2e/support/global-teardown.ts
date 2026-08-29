import { teardownHarness } from './harness';

export default function globalTeardown(): void {
  teardownHarness();
}
