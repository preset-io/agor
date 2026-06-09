import type { User, UserID } from '@agor/core/types';
import jwt, { type SignOptions } from 'jsonwebtoken';

export const RUNTIME_JWT_ISSUER = 'agor';
export const RUNTIME_JWT_AUDIENCE = 'https://agor.dev';
export const ARTIFACT_RUNTIME_JWT_AUDIENCE = 'agor:artifact-runtime';

export type RuntimeTokenType = 'access' | 'refresh' | 'service' | 'executor-session' | 'artifact';

export interface RuntimeTokenPayload {
  sub: UserID | string;
  type: RuntimeTokenType;
  [claim: string]: unknown;
}

export interface RuntimeTokenPair {
  accessToken: string;
  refreshToken: string;
}

export function issueRuntimeToken(
  payload: RuntimeTokenPayload,
  jwtSecret: string,
  expiresIn: SignOptions['expiresIn'],
  options: Pick<SignOptions, 'audience'> = {}
): string {
  return jwt.sign(payload, jwtSecret, {
    expiresIn,
    issuer: RUNTIME_JWT_ISSUER,
    audience: options.audience ?? RUNTIME_JWT_AUDIENCE,
  });
}

export function issueRuntimeTokenPair(
  user: Pick<User, 'user_id'>,
  jwtSecret: string,
  accessTokenTtl: SignOptions['expiresIn'],
  refreshTokenTtl: SignOptions['expiresIn']
): RuntimeTokenPair {
  return {
    accessToken: issueRuntimeToken(
      { sub: user.user_id, type: 'access' },
      jwtSecret,
      accessTokenTtl
    ),
    refreshToken: issueRuntimeToken(
      { sub: user.user_id, type: 'refresh' },
      jwtSecret,
      refreshTokenTtl
    ),
  };
}
