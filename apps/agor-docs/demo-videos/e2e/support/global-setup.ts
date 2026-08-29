import { setupHarness } from './harness';

export default async function globalSetup(): Promise<void> {
  await setupHarness();
}
