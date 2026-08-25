import bcrypt from 'bcryptjs';

/** One canonical bcrypt work factor for newly assigned local passwords. */
export const LOCAL_PASSWORD_BCRYPT_ROUNDS = 12;

/** Hash an already policy-validated local password for authoritative storage. */
export function hashLocalPassword(password: string): Promise<string> {
  return bcrypt.hash(password, LOCAL_PASSWORD_BCRYPT_ROUNDS);
}
