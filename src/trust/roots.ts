/**
 * Pre-loaded root entity public keys.
 *
 * THIS ARRAY IS DELIBERATELY EMPTY. See below for why.
 *
 * A root key shipped in the binary is a single coercion / subpoena / compromise
 * target: whoever holds the corresponding secret key can push "trusted"
 * statements to every install. That is precisely the single point of failure
 * this project exists to avoid (see PROPOSAL.md: "no accounts, no phone
 * numbers, no server — nothing to subpoena, nothing to seize").
 *
 * Instead of shipping root keys, the app uses a subscription model:
 *   - Users subscribe to entities they personally trust via `subscribe()`
 *   - Trust anchors propagate through the mesh as signed statements
 *   - The Coordinating Committee's key arrives the same way any contact does:
 *     by scanning a QR code, pasting a key, or accepting a signed delegation
 *     from someone you already trust
 *   - No global authority. Every user curates their own trust graph.
 *
 * If a root key must be distributed with the app (e.g. for an emergency
 * broadcast validator that must work offline from first launch), the entry
 * format is:
 *
 *   {
 *     keyHex: 'abcd1234...',  // 32-byte Ed25519 public key as lowercase hex
 *     name: 'Coordinating Committee',
 *     metadata: { organization: 'Protest Coordination Network' },
 *   }
 *
 * Before adding anything here, document:
 *   1. Who holds the corresponding secret key and how it is protected
 *      (threshold signing? hardware module? destroyed after ceremony?)
 *   2. What the revocation plan is if that key is compromised
 *      (can the app revoke it without a binary update?)
 *   3. Why this entity cannot be subscribed to at runtime via subscribe()
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
 * Pre-loaded root keys. Empty by design — see module comment above.
 */
export const PRELOADED_ROOTS: RootKeyEntry[] = [];
