import { hash, verify } from '@node-rs/argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hashed: string, password: string): Promise<boolean>;
}

export interface Argon2Params {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

/** Production parameters (Phase 0 §06-2): ~250–400 ms on a low-end office PC. */
export const PRODUCTION_ARGON2: Argon2Params = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };
/** Cheap parameters for the test suite only — still real Argon2id. */
export const TEST_ARGON2: Argon2Params = { memoryCost: 1_024, timeCost: 1, parallelism: 1 };

/**
 * Argon2id via @node-rs/argon2 (its default algorithm is Argon2id; tests assert
 * the `$argon2id$` PHC prefix). The PHC string stores its own parameters, so
 * raising them later only affects new hashes; verify() keeps working for old ones.
 */
export function createArgon2Hasher(params: Argon2Params = PRODUCTION_ARGON2): PasswordHasher {
  return {
    hash: (password) => hash(password, params),
    verify: async (hashed, password) => {
      try {
        return await verify(hashed, password);
      } catch {
        return false;
      }
    },
  };
}
