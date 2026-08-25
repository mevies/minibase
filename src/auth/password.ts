import { constantTimeEqual, decodeBase64Url, encodeBase64Url } from "./encoding.ts";
import type { AuthPasswordPolicyConfig } from "../config/types.ts";

const ALGORITHM = "pbkdf2_sha256";
const ITERATIONS = 310_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export const DEFAULT_AUTH_PASSWORD_POLICY: AuthPasswordPolicyConfig = {
  minLength: 12,
  maxLength: 256,
};

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    material,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export function validatePassword(
  password: string,
  policy: AuthPasswordPolicyConfig = DEFAULT_AUTH_PASSWORD_POLICY,
): void {
  const length = [...password].length;
  if (length < policy.minLength) {
    throw new Error(`Password must contain at least ${policy.minLength} characters`);
  }
  if (length > policy.maxLength) {
    throw new Error(`Password must contain at most ${policy.maxLength} characters`);
  }
  if (/\p{Cc}/u.test(password)) {
    throw new Error("Password must not contain control characters");
  }
}

export async function hashPassword(
  password: string,
  policy: AuthPasswordPolicyConfig = DEFAULT_AUTH_PASSWORD_POLICY,
): Promise<string> {
  validatePassword(password, policy);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [ALGORITHM, ITERATIONS, encodeBase64Url(salt), encodeBase64Url(hash)].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsValue, saltValue, hashValue] = encoded.split("$");
  const iterations = Number(iterationsValue);
  if (
    algorithm !== ALGORITHM || !Number.isInteger(iterations) || saltValue === undefined ||
    hashValue === undefined
  ) {
    return false;
  }
  const expected = decodeBase64Url(hashValue);
  const actual = await derive(password, decodeBase64Url(saltValue), iterations);
  return constantTimeEqual(actual, expected);
}
