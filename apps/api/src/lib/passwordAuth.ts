// apps/api/src/lib/passwordAuth.ts
//
// Server-side hashing/verification for LOGIN passwords (Argon2id).
// This is distinct from the client-side password-derived KDF used for
// key-wrapping (see Task 4 in apps/web) — that KDF never touches the
// server. This module is only about authenticating a login attempt.
import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes } from "node:crypto";

const ARGON2_ITERATIONS = 2;
const ARGON2_MEMORY_KIB = 19456;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2Verify({ password, hash });
}
