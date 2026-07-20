/**
 * Core types for the trust module.
 *
 * This module is completely standalone — zero imports from the rest of
 * protestchat. It depends only on @noble/curves and @noble/hashes.
 *
 * The trust module defines the identity and authorization model that the
 * rest of the app will conform to during integration.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Key identifiers
// ---------------------------------------------------------------------------

/**
 * 32-byte Ed25519 public key, the atomic identifier for any entity.
 * Stored as lowercase hex for deterministic comparison.
 */
export type KeyId = string;

export function keyIdFromPublicKey(pk: Uint8Array): KeyId {
  if (pk.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return bytesToHex(pk);
}

export function publicKeyFromKeyId(id: KeyId): Uint8Array {
  const raw = hexToBytes(id);
  if (raw.length !== 32) throw new Error('KeyId must decode to 32 bytes');
  return raw;
}

export function equalKeyId(a: KeyId, b: KeyId): boolean {
  // KeyIds are public (Ed25519 public keys), so timing is not a concern.
  // Normalize to lowercase for comparison since hex is case-insensitive
  // but keyIdFromPublicKey always produces lowercase.
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Trust kinds
// ---------------------------------------------------------------------------

/**
 * How the trust engine classifies an entity internally.
 *
 * These are ENGINE-INTERNAL labels used to resolve delegation chains.
 * They are NOT intended for display to users — the app's contact trust
 * model (safety number verification, in-person key exchange) is separate
 * and orthogonal. The engine reports VerificationResult; the app decides
 * what to show.
 *
 *   root      — subscribed as a trust anchor. Can certify other keys.
 *   delegated — trusted because a root-certified entity vouched for
 *               them via a signed delegation.
 *   direct    — known via in-person key exchange (QR scan + safety
 *               number compare). Not an authority in the delegation
 *               graph, but the engine knows who they are.
 *   none      — known but not trusted. Default for unsolicited messages.
 */
export type TrustKind = 'root' | 'delegated' | 'direct' | 'none';

// ---------------------------------------------------------------------------
// Scopes (what an entity is authorized to do)
// ---------------------------------------------------------------------------

/**
 * Actions an entity may be authorized to perform.
 *
 *   certify   — can delegate authority to other entities (create delegations)
 *   announce  — can sign statements shown to users as "trusted"
 *   validate  — can counter-sign emergency messages
 */
export type Scope = 'certify' | 'announce' | 'validate';

export const ALL_SCOPES: Scope[] = ['certify', 'announce', 'validate'];

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/**
 * An entity in the trust graph. Anything with an Ed25519 key pair.
 */
export interface Entity {
  id: KeyId;
  publicKey: Uint8Array;
  name: string;
  trustKind: TrustKind;
  addedAt: number;
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Statement types
// ---------------------------------------------------------------------------

export type StatementType =
  | 'text'
  | 'delegation'
  | 'revocation'
  | 'announcement'
  | 'emergency';

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

/**
 * A signed claim. This is the primary communication unit — everything that
 * flows through the mesh is a statement.
 *
 * The `payload` is type-specific opaque bytes. The trust module does not
 * interpret it; the integration layer decides what each type's payload means.
 */
export interface Statement {
  /**
   * Deterministic hash of the canonical serialization (see serializeStatement).
   * SHA-256 over: typeIndex(1) || issuerRaw(32) || payloadLen(4) || payload(N)
   * || issuedAt(8) || expiryFlag(1) || [expiresAt(8)].
   * Set by the TrustEngine during verify() — the issuer's value is overwritten.
   */
  id: string;
  type: StatementType;
  /** KeyId of the signing entity */
  issuer: KeyId;
  /**
   * Type-specific content.
   * For 'delegation' and 'revocation' types, the trust module interprets this
   * as JSON with specific fields (delegate/scope for delegation, target/reason
   * for revocation). For all other types the payload is opaque.
   */
  payload: Uint8Array;
  issuedAt: number;
  expiresAt?: number;
}

/**
 * A statement with its Ed25519 signature attached.
 */
export interface SignedStatement {
  statement: Statement;
  /** Ed25519 signature over the canonical serialization of the statement */
  signature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

/**
 * A delegation of authority from one entity to another.
 *
 * Created when a 'delegation' statement is verified and accepted.
 */
export interface Delegation {
  id: string;
  /** Who granted this delegation */
  issuer: KeyId;
  /** Who received the authority */
  delegate: KeyId;
  /** What the delegate is authorized to do */
  scope: Scope[];
  issuedAt: number;
  expiresAt?: number;
  /** The signed statement that created this delegation */
  statementId: string;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * Revocation of a delegation.
 *
 * Created when a 'revocation' statement is verified and accepted.
 * The issuer must be either the original delegator or an entity with
 * certify scope along the delegate's trust chain.
 */
export interface Revocation {
  id: string;
  /** Who issued the revocation */
  issuer: KeyId;
  /** Whose delegation is revoked (the delegate) */
  target: KeyId;
  reason: string;
  issuedAt: number;
  /** The signed statement that created this revocation */
  statementId: string;
}

// ---------------------------------------------------------------------------
// Emergency validation
// ---------------------------------------------------------------------------

/**
 * A counter-signature on an emergency statement.
 */
export interface Validation {
  /** The emergency statement being validated */
  statementId: string;
  /** Who is validating */
  validator: KeyId;
  validatedAt: number;
  /** Ed25519 signature over statementId by the validator's secret key.
   *  Proves the validator actually controls their private key. */
  signature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * The engine's assessment of a signed statement.
 *
 * These statuses describe the engine's internal trust determination.
 * The app decides whether and how to surface them. For example,
 * 'trusted' might render as a verified badge for an emergency alert,
 * while 'untrusted' is the normal state for messages from strangers
 * (the app's default; no special treatment needed).
 *
 *   trusted            — verified by the engine's trust graph.
 *   known              — signed by a known entity but not a trusted authority.
 *   untrusted          — signature is valid but issuer is unknown/untrusted.
 *   revoked            — the issuer's key or delegation has been revoked.
 *   expired            — the statement is past its expiry time.
 *   unknown-issuer     — the issuer's key is not in the engine's store.
 *   verified-emergency — emergency that met the validation threshold.
 *   pending-emergency  — emergency awaiting more validations.
 */
export type VerificationStatus =
  | 'trusted'
  | 'known'
  | 'untrusted'
  | 'revoked'
  | 'expired'
  | 'unknown-issuer'
  | 'verified-emergency'
  | 'pending-emergency';

/**
 * The result of verifying a signed statement.
 */
export interface VerificationResult {
  status: VerificationStatus;
  /** The signed statement. Absent for error cases where no statement exists
   *  (e.g. validateEmergency called with an unknown statement ID). */
  signed?: SignedStatement;
  /** The trust chain from issuer to a root, if applicable */
  trustChain?: Entity[];
  /** Validations collected, for emergency statements */
  validations?: Validation[];
  /** Human-readable explanation */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deterministically serialize a statement for signing/verification.
 *
 * The format is deliberately explicit (not JSON.stringify) so that the
 * serialization is platform-independent and never changes with JS engine
 * versions. Every field is fixed-length or length-prefixed.
 *
 * Layout per field:
 *   type       — 1 byte (enum index)
 *   issuer     — 32 bytes (raw Ed25519 public key)
 *   payloadLen — 4 bytes (big-endian uint32)
 *   payload    — N bytes
 *   issuedAt   — 8 bytes (big-endian uint64)
 *   expiresAt  — 1 byte flag + 0 or 8 bytes (big-endian uint64)
 */
export function serializeStatement(stmt: Statement): Uint8Array {
  const typeIndex = STATEMENT_TYPE_INDEX[stmt.type];
  if (typeIndex === undefined) {
    throw new Error(`Unknown statement type: ${stmt.type}`);
  }
  const issuerRaw = publicKeyFromKeyId(stmt.issuer);
  const payloadLen = stmt.payload.length;
  const hasExpiry = stmt.expiresAt !== undefined;

  const size = 1 + 32 + 4 + payloadLen + 8 + 1 + (hasExpiry ? 8 : 0);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;
  buf[off++] = typeIndex;
  buf.set(issuerRaw, off); off += 32;
  dv.setUint32(off, payloadLen); off += 4;
  buf.set(stmt.payload, off); off += payloadLen;
  dv.setBigUint64(off, BigInt(stmt.issuedAt)); off += 8;
  buf[off++] = hasExpiry ? 1 : 0;
  if (hasExpiry) {
    dv.setBigUint64(off, BigInt(stmt.expiresAt!)); off += 8;
  }

  return buf;
}

const STATEMENT_TYPE_INDEX: Readonly<Record<StatementType, number>> = Object.freeze({
  text: 0,
  delegation: 1,
  revocation: 2,
  announcement: 3,
  emergency: 4,
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute the statement ID (SHA-256 of the canonical serialization).
 */
export function hashStatement(stmt: Statement): string {
  return bytesToHex(sha256(serializeStatement(stmt)));
}

/**
 * Compute SHA-256 hash of an already-serialized statement.
 * Use this instead of hashStatement when the serialized bytes are already
 * available to avoid redundant serialization.
 */
export function hashSerialized(serialized: Uint8Array): string {
  return bytesToHex(sha256(serialized));
}
