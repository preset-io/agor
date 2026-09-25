/**
 * The unclassified-service baseline ratchet, driven at its actual boundary.
 *
 * The case this exists for is the REPLACEMENT, not the 58th entry: the
 * previous check counted `BASELINE-ENTRY` markers, so classifying one old
 * service and listing one new unclassified one left the total at 57 and every
 * check green. A closed debt inventory and a replenishable allowance are
 * indistinguishable by count; only the names tell them apart.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPROVED_UNCLASSIFIED_SERVICE_BASELINE,
  checkUnclassifiedServiceBaseline,
} from './check-multitenancy-boundaries.mjs';

const approved = ['authentication', 'health', 'repos/clone'];
const fileWith = (...entries) =>
  `export const UNCLASSIFIED_SERVICE_BASELINE = [\n${entries
    .map((entry) => `  '${entry}', // BASELINE-ENTRY`)
    .join('\n')}\n];\n`;

test('the approved inventory is exactly what the daemon file lists today', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'apps/agor-daemon/src/utils/tenant-service-classification.ts'),
    'utf8'
  );
  assert.deepEqual(checkUnclassifiedServiceBaseline(source), []);
  assert.equal(APPROVED_UNCLASSIFIED_SERVICE_BASELINE.length, 57);
});

/** What the previous ratchet actually asked: how many markers are in the file. */
const countMarkers = (source) => [...source.matchAll(/\/\/ BASELINE-ENTRY/g)].length;

test('one old entry out, one new name in — same count, refused', () => {
  const replaced = fileWith('authentication', 'health', 'mcp-slack-connect/reinvite');
  // The escape, stated as the old check saw it: 3 markers, cap of 3, green.
  assert.ok(countMarkers(replaced) <= approved.length);
  const errors = checkUnclassifiedServiceBaseline(replaced, approved);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /'mcp-slack-connect\/reinvite' is not one of the 3 approved/);
  assert.match(errors[0], /declare the service in TENANT_SERVICE_CLASSIFICATIONS/);
  // And the departed name has to leave the approved list in the same change.
  assert.match(errors[1], /'repos\/clone' has left the baseline/);
});

test('a 58th entry is refused too', () => {
  const errors = checkUnclassifiedServiceBaseline(
    fileWith('authentication', 'health', 'repos/clone', 'branches/:id/reheat'),
    approved
  );
  assert.deepEqual(errors.length, 1);
  assert.match(errors[0], /'branches\/:id\/reheat' is not one of the 3 approved/);
});

test('shrinking is allowed, and required to be recorded in both places', () => {
  // Classifying `repos/clone` removes it from the file. That alone fails,
  // with the instruction that closes the re-listing hole...
  const partial = checkUnclassifiedServiceBaseline(fileWith('authentication', 'health'), approved);
  assert.equal(partial.length, 1);
  assert.match(partial[0], /remove it from APPROVED_UNCLASSIFIED_SERVICE_BASELINE/);
  // ...and doing both is green, at a permanently lower ceiling.
  assert.deepEqual(
    checkUnclassifiedServiceBaseline(fileWith('authentication', 'health'), [
      'authentication',
      'health',
    ]),
    []
  );
});

test('a name cannot be re-listed once it has left the approved inventory', () => {
  // The point of removing the approval too: `repos/clone` could otherwise be
  // deleted from the daemon, dropped from the baseline, and re-registered
  // unclassified later with nothing objecting.
  const errors = checkUnclassifiedServiceBaseline(fileWith('authentication', 'repos/clone'), [
    'authentication',
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'repos\/clone' is not one of the 1 approved/);
});

test('the same service listed twice is refused', () => {
  const errors = checkUnclassifiedServiceBaseline(
    fileWith('authentication', 'authentication', 'health', 'repos/clone'),
    approved
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'authentication' is listed twice/);
});
