import { hash, verify } from "@node-rs/argon2";

/** Algorithm.Argon2id in @node-rs/argon2 (a const enum, which isolated modules cannot import). */
const ARGON2ID = 2;

/**
 * Argon2id password hashing. Parameters follow the OWASP Password Storage Cheat Sheet minimum
 * for Argon2id (19 MiB memory, 2 iterations, 1 lane). Review before production.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new RangeError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a fixed dummy hash. Used when the username does not exist, so a failed
 * login takes about the same time whether or not the account exists.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hash("dummy-password-for-timing-equalisation", OPTIONS);
  await verifyPassword(await dummyHash, password);
  return false;
}
