import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ExternalUserAuthorityState } from '../../types/user';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import { externalUserAuthority, userExternalIdentities, users } from '../schema';
import { UserExternalIdentitiesRepository } from './user-external-identities';

export function externalAuthorityIdentityKey(
  provider: string,
  issuer: string,
  subject: string
): string {
  return createHash('sha256').update(`${provider}\0${issuer}\0${subject}`).digest('hex');
}

export function authorityOrdinal(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  ) {
    throw new Error('Invalid authority ordinal');
  }
  return BigInt(value);
}

/** Caller must hold the tenant authorization fence in a short write transaction. */
export class ExternalUserAuthorityRepository {
  constructor(private readonly db: Database) {}

  async find(provider: string, issuer: string, subject: string) {
    return select(this.db)
      .from(externalUserAuthority)
      .where(
        eq(
          externalUserAuthority.identity_key,
          externalAuthorityIdentityKey(provider, issuer, subject)
        )
      )
      .one();
  }

  async apply(state: ExternalUserAuthorityState) {
    const revision = authorityOrdinal(state.revision);
    const epoch = authorityOrdinal(state.login_epoch);
    const key = externalAuthorityIdentityKey(state.provider, state.issuer, state.subject);
    const previous = await this.find(state.provider, state.issuer, state.subject);
    if (previous) {
      if (revision < authorityOrdinal(previous.revision))
        return { row: previous, outcome: 'superseded' as const };
      if (revision === authorityOrdinal(previous.revision)) {
        if (
          previous.login_epoch !== state.login_epoch ||
          previous.active !== state.active ||
          previous.role !== state.role
        ) {
          throw new Error('Conflicting authority revision');
        }
        return { row: previous, outcome: 'duplicate' as const };
      }
      const priorEpoch = authorityOrdinal(previous.login_epoch);
      if (
        epoch < priorEpoch ||
        ((previous.active !== state.active || previous.role !== state.role) && epoch === priorEpoch)
      ) {
        throw new Error('Authority epoch must advance');
      }
      await update(this.db, externalUserAuthority)
        .set(state)
        .where(eq(externalUserAuthority.identity_key, key))
        .run();
    } else {
      await insert(this.db, externalUserAuthority)
        .values({ identity_key: key, ...state })
        .run();
    }
    const binding = await new UserExternalIdentitiesRepository(this.db).findByKey(key);
    if (binding) {
      await update(this.db, users)
        .set({
          role: state.role,
          access_disabled: !state.active,
          ...(!previous || state.login_epoch !== previous.login_epoch
            ? {
                credential_generation: sql`${users.credential_generation} + 1`,
                tokens_valid_after: new Date(),
              }
            : {}),
        })
        .where(eq(users.user_id, binding.user_id))
        .run();
    }
    return {
      row: { identity_key: key, ...state },
      outcome: 'applied' as const,
      userId: binding?.user_id,
    };
  }
}

/** Same live projection for interactive access and existing Task admission/heartbeat. */
export function externalUserAuthorityPredicate(
  userId: string,
  external?: Pick<ExternalUserAuthorityState, 'provider' | 'issuer'>
) {
  if (!external) return sql<boolean>`true`;
  if (!external.provider || !external.issuer) return sql<boolean>`false`;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${userExternalIdentities} AS binding
    JOIN ${externalUserAuthority} AS authority ON authority.identity_key = binding.identity_key
    WHERE binding.user_id = ${userId}
      AND binding.provider = ${external.provider} AND binding.issuer = ${external.issuer}
      AND authority.provider = binding.provider AND authority.issuer = binding.issuer
      AND authority.subject = binding.subject AND authority.active = true
  )`;
}
