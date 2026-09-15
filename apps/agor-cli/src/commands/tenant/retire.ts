import { ManagedRetirementCommand } from '../../lib/managed-oauth-retirement.js';
export default class TenantRetire extends ManagedRetirementCommand {
  static override summary =
    'Retire managed OAuth authority under an already-held tenant write gate';
  static override description =
    'DB-only retirement. The source daemon drains exact-old cleanup separately. Never releases the gate or claims provider revocation.';
  protected override retire = true;
}
