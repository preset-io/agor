import { it } from 'vitest';
import { runStableCallbackFixture } from './oauth-stable-callback.test-fixture';

it.each([false, true])(
  'preserves exact callbacks, PKCE, issuer and app identity (%s)',
  (confidential) => runStableCallbackFixture(confidential)
);
