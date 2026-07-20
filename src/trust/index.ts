/**
 * Trust module — standalone identity, authorization, and trust management.
 *
 * This module is completely independent of the protestchat mesh protocol.
 * It manages:
 *   - Entities (Ed25519 public keys with trust levels)
 *   - Delegations (signed authority grants)
 *   - Revocations (delegation cancellation)
 *   - Emergency messages with threshold validation
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
