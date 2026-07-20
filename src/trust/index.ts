/**
 * Trust module — identity, authorization, and emergency-broadcast authentication.
 *
 * This module is completely independent of the protestchat mesh protocol.
 * It manages:
 *   - Entities (Ed25519 public keys with trust levels)
 *   - Delegations (signed authority grants from subscribed entities)
 *   - Revocations (delegation cancellation)
 *   - Emergency messages with threshold validation
 *   - Subscription system: users choose who they trust
 *
 * Subscription model (not global authority):
 *   - Every user curates their own trust graph via subscribe()
 *   - No pre-loaded root keys in the binary (PRELOADED_ROOTS is empty)
 *   - Trust anchors arrive the same way any contact does: QR, paste, or
 *     signed delegation from someone you already trust
 *   - Delegations are MEMORY ONLY — never persisted to disk, rebuilt from
 *     signed statements on every start (see DESIGN.md for rationale)
 *
 * The module depends only on @noble/curves and @noble/hashes.
 * It imports nothing from src/lib/.
 *
 * During integration, every incoming message passes through
 * TrustEngine.verify() to determine how it should be displayed.
 */

export { TrustEngine } from './engine';
export { createMemoryTrustStore } from './store';
export type { TrustStore } from './store';

export { PRELOADED_ROOTS } from './roots';
export type { RootKeyEntry } from './roots';

export {
  keyIdFromPublicKey,
  publicKeyFromKeyId,
  equalKeyId,
  hashStatement,
  serializeStatement,
  ALL_SCOPES,
} from './types';

export type {
  KeyId,
  TrustKind,
  Scope,
  Entity,
  StatementType,
  Statement,
  SignedStatement,
  Delegation,
  Revocation,
  Validation,
  VerificationStatus,
  VerificationResult,
} from './types';
