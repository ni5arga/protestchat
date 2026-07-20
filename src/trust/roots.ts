/**
 * Pre-loaded root entity public keys.
 *
 * These are the ultimate trust anchors — entities that the app trusts by
 * default without any prior interaction. The Coordinating Committee's key
 * would go here, distributed with the app binary.
 *
 * Each entry is a hex-encoded 32-byte Ed25519 public key and a human name.
 *
 * During integration, the app calls:
 *   trustEngine.subscribe(hexToBytes(entry.keyHex), entry.name, 'root', entry.metadata)
 */

export interface RootKeyEntry {
  /** 32-byte Ed25519 public key as lowercase hex */
  keyHex: string;
  /** Human-readable name for this entity */
  name: string;
  /** Optional metadata (organization, contact info, etc.) */
  metadata?: Record<string, string>;
}

/**
 * Pre-loaded root keys. Empty by default — fill in during integration.
 *
 * Format: 32-byte Ed25519 public key as lowercase hex.
 * Example: { keyHex: 'abcd1234...', name: 'Coordinating Committee' }
 */
export const PRELOADED_ROOTS: RootKeyEntry[] = [];
