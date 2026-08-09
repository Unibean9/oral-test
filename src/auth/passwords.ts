import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;
const SALT_BYTES = 16;

// scrypt (Node built-in, no new dependency) rather than bcrypt/argon2: this is a small pilot
// tool with a handful of teacher accounts, not a public-facing auth system, so the stdlib
// primitive is enough and keeps package.json lean.
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  // timingSafeEqual throws on length mismatch rather than returning false — guard explicitly so
  // a malformed/truncated stored hash cannot crash the request instead of just failing auth.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
