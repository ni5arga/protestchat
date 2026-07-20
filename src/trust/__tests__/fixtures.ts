/**
 * Test fixtures for the trust module.
 *
 * Generates deterministic Ed25519 key pairs for reproducible tests.
 */

import { ed25519 } from '@noble/curves/ed25519.js';

import { keyIdFromPublicKey } from '../types';
import type { KeyId } from '../types';

export interface TestKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  id: KeyId;
}

/**
 * Create a deterministic key pair from a seed byte.
 */
export function createKey(seed: number): TestKeyPair {
  const sk = new Uint8Array(32).fill(seed);
  const pk = ed25519.getPublicKey(sk);
  return { secretKey: sk, publicKey: pk, id: keyIdFromPublicKey(pk) };
}

/**
 * Create N deterministic key pairs.
 */
export function createKeys(count: number): TestKeyPair[] {
  return Array.from({ length: count }, (_, i) => createKey(i + 1));
}
